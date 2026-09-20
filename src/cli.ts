#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { cosmiconfig } from 'cosmiconfig';
import { Command, InvalidArgumentError } from 'commander';
// resolveJsonModule lets rolldown (via tsdown) inline this package's own declared version straight into the bundle at build time -- no runtime fs read.
import { version } from '../package.json';
import { ReleaseConfigurationError, WorkspaceReleaseError } from './errors';
import { isDetachedPackageReleaseArray, resumeWorkspaceRelease } from './gate-publish';
import { isJsonObject, isStringArray, isUnknownArray } from './json';
import { packageName } from './package-name';
import { type PackagePluginSpecs, type PublishPluginSpec } from './plugins';
import { releaseWorkspace, type CommitStrategy, type PackageReleaseOutcome } from './release';
import { validateTagFormat } from './tag-format';

const CONFIG_OPTION_KEYS: ReadonlySet<string> = new Set([
  'dryRun',
  'branches',
  'plugins',
  'packagePlugins',
  'analyzeCommits',
  'generateNotes',
  'commitStrategy',
  'gatePublish',
  'tagFormat',
]);
const COMMIT_STRATEGIES: ReadonlySet<string> = new Set<CommitStrategy>(['per-package', 'single']);

function isCommitStrategy(value: string): value is CommitStrategy {
  return COMMIT_STRATEGIES.has(value);
}

/**
 * Builds the commander program but never parses argv or exits the process itself in construction, so the command tree stays testable in isolation. `release` is the orchestration entry point: discover the workspace, order it topologically, and run semantic-release per package.
 */
export function createProgram(): Command {
  const program = new Command('semantic-release-workspace');
  program.description('Independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.');
  program.version(version);

  const release = program.command('release');
  release.description('Release every package in the workspace in dependency order, each with its own version and changelog.');
  release.option('--root <directory>', 'workspace root holding pnpm-workspace.yaml', process.cwd());
  release.option('--dry-run', 'analyse and report only: no publishing, tagging, committing, or pushing');
  release.option('--branches <branch>', 'release branch for semantic-release; repeat for multiple branches', collectRepeated, []);
  release.option(
    '--plugin <spec>',
    'publish-pipeline plugin, repeatable: a module name, or a JSON array of [name, config]; defaults to the standard changelog/npm/github/git pipeline',
    collectRepeated,
    [],
  );
  release.option('--analyze-commits <json>', 'options for the wrapped @semantic-release/commit-analyzer, as a JSON object');
  release.option('--generate-notes <json>', 'options for the wrapped @semantic-release/release-notes-generator, as a JSON object');
  release.option(
    '--commit-strategy <mode>',
    'how the run commits its released changes: "per-package" (default; today\'s behaviour, one commit per release plus one per dependency bump) or "single" (one combined commit for the whole run, tagged once per released package)',
    parseCommitStrategy,
  );
  release.option(
    '--tag-format <template>',
    'template for each package\'s release tag, with ${name} and ${version} placeholders; must contain ${version} (default: ${name}@${version})',
    parseTagFormat,
  );
  release.option(
    '--gate-publish',
    'tag and push each due package via @exadev/release-gate, but defer publishing -- requires --gate-state-file, and cannot be combined with --commit-strategy single',
  );
  release.option(
    '--gate-state-file <path>',
    'with --gate-publish: where to write the state a later "resume" run needs to finish publishing',
  );
  release.option(
    '--config <file>',
    'config file (.json, .yaml, .yml, .js, .cjs, or .ts) providing any of the release options (dryRun, branches, plugins, packagePlugins, analyzeCommits, generateNotes, commitStrategy, tagFormat, gatePublish); explicit flags win',
  );
  release.action(runRelease);

  const resume = program.command('resume');
  resume.description('Finish publishing every package a --gate-publish release tagged and pushed but did not publish.');
  resume.option('--root <directory>', 'workspace root holding pnpm-workspace.yaml (this checkout, which may differ from the one that ran release --gate-publish)', process.cwd());
  resume.requiredOption('--gate-state-file <path>', 'the state file a "release --gate-publish" run wrote');
  resume.action(runResume);

  return program;
}

function parseCommitStrategy(value: string): CommitStrategy {
  if (!isCommitStrategy(value)) {
    throw new InvalidArgumentError(`--commit-strategy must be one of: ${[...COMMIT_STRATEGIES].join(', ')}`);
  }
  return value;
}

function parseTagFormat(value: string): string {
  return validateTagFormatOption(value, (message) => message);
}

/**
 * Runs `validateTagFormat` and turns its `ReleaseConfigurationError` into the `InvalidArgumentError` the CLI reports as a usage mistake. `describe` lets each caller say where the value came from (a flag needs no prefix, since commander already names the option; a config file entry needs the file's path).
 */
function validateTagFormatOption(value: string, describe: (message: string) => string): string {
  try {
    return validateTagFormat(value);
  } catch (cause) {
    if (cause instanceof ReleaseConfigurationError) {
      throw new InvalidArgumentError(describe(cause.message));
    }
    throw cause;
  }
}

interface ReleaseFlags {
  readonly root: string;
  readonly dryRun: boolean | undefined;
  readonly branches: string[];
  readonly plugin: string[];
  readonly analyzeCommits: string | undefined;
  readonly generateNotes: string | undefined;
  readonly commitStrategy: CommitStrategy | undefined;
  readonly tagFormat: string | undefined;
  readonly gatePublish: boolean | undefined;
  readonly gateStateFile: string | undefined;
  readonly config: string | undefined;
}

const NO_CONFIG_FILE: ReleaseConfigFile = {
  dryRun: undefined,
  branches: undefined,
  plugins: undefined,
  packagePlugins: undefined,
  analyzeCommits: undefined,
  generateNotes: undefined,
  commitStrategy: undefined,
  tagFormat: undefined,
  gatePublish: undefined,
};

async function runRelease(flags: ReleaseFlags): Promise<void> {
  const file = flags.config === undefined ? NO_CONFIG_FILE : await readReleaseConfigFile(flags.config);
  const gatePublish = flags.gatePublish ?? file.gatePublish ?? false;
  if (gatePublish && flags.gateStateFile === undefined) {
    throw new InvalidArgumentError('--gate-publish requires --gate-state-file, since that is where the state a later "resume" run needs gets written');
  }

  const outcome = await releaseWorkspace({
    root: flags.root,
    dryRun: flags.dryRun ?? (file.dryRun === true ? true : undefined),
    branches: flags.branches.length > 0 ? flags.branches : file.branches,
    // No `?? DEFAULT_PUBLISH_PLUGINS` fallback here: which default plugin list applies depends on commitStrategy (git is part of the default for "per-package", forbidden for "single"), so an unset `plugins` is passed straight through and `releaseWorkspace` picks the right default for whichever strategy is in effect.
    plugins: flags.plugin.length > 0 ? flags.plugin.map((spec) => parsePluginSpec(spec)) : file.plugins,
    // Config file only: per-package lists are keyed by package name, which a repeatable flag has no natural shape for.
    packagePlugins: file.packagePlugins,
    analyzeCommits: flags.analyzeCommits === undefined ? file.analyzeCommits : parseJsonObjectFlag(flags.analyzeCommits, '--analyze-commits'),
    generateNotes: flags.generateNotes === undefined ? file.generateNotes : parseJsonObjectFlag(flags.generateNotes, '--generate-notes'),
    commitStrategy: flags.commitStrategy ?? file.commitStrategy,
    tagFormat: flags.tagFormat ?? file.tagFormat,
    gatePublish,
  });

  for (const pkg of outcome.packages) {
    console.log(describeOutcome(pkg));
  }

  if (gatePublish) {
    // Asserted, not defaulted: the flags.gateStateFile === undefined case above already rejected this combination before releaseWorkspace ever ran, so reaching here with it still undefined would mean that check regressed, not a legitimate state to fall back from silently.
    if (flags.gateStateFile === undefined) {
      throw new WorkspaceReleaseError('gatePublish was true but no --gate-state-file was resolved -- this should be unreachable.');
    }
    await writeFile(flags.gateStateFile, JSON.stringify(outcome.detached ?? [], null, 2));
    console.log(`${packageName}: wrote gate state for ${String((outcome.detached ?? []).length)} package(s) to ${flags.gateStateFile}`);
  }
}

interface ResumeFlags {
  readonly root: string;
  readonly gateStateFile: string;
}

async function runResume(flags: ResumeFlags): Promise<void> {
  const raw = await readFile(flags.gateStateFile, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isDetachedPackageReleaseArray(parsed)) {
    throw new InvalidArgumentError(`--gate-state-file ${flags.gateStateFile} does not contain a valid gate state array`);
  }

  const outcome = await resumeWorkspaceRelease({ root: flags.root, detached: parsed });
  for (const pkg of outcome.packages) {
    console.log(describeOutcome(pkg));
  }
}

function describeOutcome(pkg: PackageReleaseOutcome): string {
  if (!pkg.released) {
    return `${pkg.name}: no release`;
  }
  const bumps = pkg.dependencyBumps.map((bump) => `${bump.dependency} ${bump.range}`).join(', ');
  return `${pkg.name}: ${pkg.gitTag} (${pkg.type}${bumps === '' ? '' : `; dependency bumps: ${bumps}`})`;
}

function collectRepeated(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function parseJsonObjectFlag(raw: string, flag: string): Record<string, unknown> {
  const parsed: unknown = parseJson(raw, flag);
  if (!isJsonObject(parsed)) {
    throw new InvalidArgumentError(`${flag} must be a JSON object`);
  }
  return parsed;
}

/** Narrows an unknown JSON value into a publish-plugin tuple: [name] or [name, config]. */
function isPluginSpecTuple(value: unknown): value is readonly [string] | readonly [string, Record<string, unknown>] {
  if (!isUnknownArray(value)) {
    return false;
  }
  const [name, config] = value;
  if (typeof name !== 'string') {
    return false;
  }
  return config === undefined || isJsonObject(config);
}

function parsePluginSpec(raw: string): PublishPluginSpec {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) {
    return trimmed;
  }
  const parsed: unknown = parseJson(trimmed, '--plugin');
  if (!isPluginSpecTuple(parsed)) {
    throw new InvalidArgumentError('--plugin must be a module name or a JSON array of [name, config]');
  }
  return parsed;
}

export interface ReleaseConfigFile {
  readonly dryRun: boolean | undefined;
  readonly branches: readonly string[] | undefined;
  readonly plugins: readonly PublishPluginSpec[] | undefined;
  readonly packagePlugins: PackagePluginSpecs | undefined;
  readonly analyzeCommits: Record<string, unknown> | undefined;
  readonly generateNotes: Record<string, unknown> | undefined;
  readonly commitStrategy: CommitStrategy | undefined;
  readonly tagFormat: string | undefined;
  readonly gatePublish: boolean | undefined;
}

// The asynchronous explorer, not `cosmiconfigSync`: the synchronous one loads `.js` and `.ts` files through `require()`, which for a module using `export default` returns the whole module namespace (`default`, `__esModule`, and every named export) rather than the default export, so a config file exporting anything besides its default would be rejected as having unknown options. The asynchronous one imports the file and hands back its default export.
// A single explorer instance would carry cosmiconfig's own load cache across every --config read, which never helps here (the CLI reads a given path at most once per process) and would be a stale-cache hazard for the one thing that does invoke this function repeatedly: this file's own test suite loading many different fixture paths in one process.
async function readConfigFile(path: string): Promise<unknown> {
  const explorer = cosmiconfig('semantic-release-workspace');
  let result: Awaited<ReturnType<typeof explorer.load>>;
  try {
    result = await explorer.load(path);
  } catch (cause) {
    throw new InvalidArgumentError(`--config file ${path} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (result === null || result.isEmpty === true) {
    throw new InvalidArgumentError(`--config file ${path} is empty`);
  }
  return result.config;
}

export async function readReleaseConfigFile(path: string): Promise<ReleaseConfigFile> {
  const parsed: unknown = await readConfigFile(path);
  if (!isJsonObject(parsed)) {
    throw new InvalidArgumentError(`--config file ${path} must contain a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_OPTION_KEYS.has(key)) {
      throw new InvalidArgumentError(`--config file ${path} has an unknown option "${key}"; recognised options: ${[...CONFIG_OPTION_KEYS].join(', ')}`);
    }
  }

  const { dryRun, branches, plugins, packagePlugins, analyzeCommits, generateNotes, commitStrategy, tagFormat, gatePublish } = parsed;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new InvalidArgumentError(`--config file ${path}: "dryRun" must be a boolean`);
  }
  if (branches !== undefined && !isStringArray(branches)) {
    throw new InvalidArgumentError(`--config file ${path}: "branches" must be an array of branch name strings`);
  }
  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new InvalidArgumentError(`--config file ${path}: "plugins" must be an array`);
  }
  if (packagePlugins !== undefined && !isJsonObject(packagePlugins)) {
    throw new InvalidArgumentError(`--config file ${path}: "packagePlugins" must be an object mapping package names to plugin arrays`);
  }
  if (analyzeCommits !== undefined && !isJsonObject(analyzeCommits)) {
    throw new InvalidArgumentError(`--config file ${path}: "analyzeCommits" must be an object`);
  }
  if (generateNotes !== undefined && !isJsonObject(generateNotes)) {
    throw new InvalidArgumentError(`--config file ${path}: "generateNotes" must be an object`);
  }
  if (commitStrategy !== undefined && (typeof commitStrategy !== 'string' || !isCommitStrategy(commitStrategy))) {
    throw new InvalidArgumentError(`--config file ${path}: "commitStrategy" must be one of: ${[...COMMIT_STRATEGIES].join(', ')}`);
  }
  if (tagFormat !== undefined && typeof tagFormat !== 'string') {
    throw new InvalidArgumentError(`--config file ${path}: "tagFormat" must be a string`);
  }
  if (gatePublish !== undefined && typeof gatePublish !== 'boolean') {
    throw new InvalidArgumentError(`--config file ${path}: "gatePublish" must be a boolean`);
  }

  return {
    dryRun,
    branches,
    plugins: plugins === undefined ? undefined : plugins.map((spec) => parseConfigFilePlugin(spec, path)),
    packagePlugins: packagePlugins === undefined ? undefined : parseConfigFilePackagePlugins(packagePlugins, path),
    analyzeCommits,
    generateNotes,
    commitStrategy,
    tagFormat: tagFormat === undefined ? undefined : validateTagFormatOption(tagFormat, (message) => `--config file ${path}: ${message}`),
    gatePublish,
  };
}

function parseConfigFilePackagePlugins(packagePlugins: Record<string, unknown>, path: string): PackagePluginSpecs {
  const parsed: Record<string, readonly PublishPluginSpec[]> = {};
  for (const [name, list] of Object.entries(packagePlugins)) {
    if (!Array.isArray(list)) {
      throw new InvalidArgumentError(`--config file ${path}: the "packagePlugins" entry for "${name}" must be an array`);
    }
    parsed[name] = list.map((spec: unknown) => parseConfigFilePlugin(spec, path, 'packagePlugins'));
  }
  return parsed;
}

function parseConfigFilePlugin(spec: unknown, path: string, key = 'plugins'): PublishPluginSpec {
  if (typeof spec === 'string') {
    return spec;
  }
  if (isPluginSpecTuple(spec)) {
    return spec;
  }
  throw new InvalidArgumentError(`--config file ${path}: each "${key}" entry must be a module name or a [name, config] array`);
}

function parseJson(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new InvalidArgumentError(`${flag} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// parseAsync rather than parse: the release action is async, and a sync parse would turn any failure into an unhandled rejection instead of this handler's clean message and exit code. Deliberate orchestration failures print their message only; anything unexpected keeps its stack.
createProgram()
  .parseAsync(process.argv)
  .catch((cause: unknown) => {
    if (cause instanceof WorkspaceReleaseError) {
      console.error(`${packageName}: ${cause.message}`);
    } else if (cause instanceof Error) {
      console.error(cause.stack ?? cause.message);
    } else {
      console.error(String(cause));
    }
    process.exitCode = 1;
  });
