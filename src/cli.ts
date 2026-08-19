#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
// resolveJsonModule lets rolldown (via tsdown) inline this package's own declared version straight into the bundle at build time -- no runtime fs read.
import { version } from '../package.json';
import { WorkspaceReleaseError } from './errors';
import { isJsonObject, isStringArray, isUnknownArray } from './json';
import { packageName } from './package-name';
import { DEFAULT_PUBLISH_PLUGINS, type PublishPluginSpec } from './plugins';
import { releaseWorkspace, type PackageReleaseOutcome } from './release';

const CONFIG_OPTION_KEYS: ReadonlySet<string> = new Set(['dryRun', 'branches', 'plugins', 'analyzeCommits', 'generateNotes']);

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
  release.option('--config <file>', 'JSON file providing any of the release options (dryRun, branches, plugins, analyzeCommits, generateNotes); explicit flags win');
  release.action(runRelease);

  return program;
}

interface ReleaseFlags {
  readonly root: string;
  readonly dryRun: boolean | undefined;
  readonly branches: string[];
  readonly plugin: string[];
  readonly analyzeCommits: string | undefined;
  readonly generateNotes: string | undefined;
  readonly config: string | undefined;
}

const NO_CONFIG_FILE: ReleaseConfigFile = { dryRun: undefined, branches: undefined, plugins: undefined, analyzeCommits: undefined, generateNotes: undefined };

async function runRelease(flags: ReleaseFlags): Promise<void> {
  const file = flags.config === undefined ? NO_CONFIG_FILE : readReleaseConfigFile(flags.config);
  const outcome = await releaseWorkspace({
    root: flags.root,
    dryRun: flags.dryRun ?? (file.dryRun === true ? true : undefined),
    branches: flags.branches.length > 0 ? flags.branches : file.branches,
    plugins:
      flags.plugin.length > 0 ? flags.plugin.map((spec) => parsePluginSpec(spec)) : (file.plugins ?? DEFAULT_PUBLISH_PLUGINS),
    analyzeCommits: flags.analyzeCommits === undefined ? file.analyzeCommits : parseJsonObjectFlag(flags.analyzeCommits, '--analyze-commits'),
    generateNotes: flags.generateNotes === undefined ? file.generateNotes : parseJsonObjectFlag(flags.generateNotes, '--generate-notes'),
  });

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

function collectRepeated(value: string, previous: string[]): string[] {
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

interface ReleaseConfigFile {
  readonly dryRun: boolean | undefined;
  readonly branches: readonly string[] | undefined;
  readonly plugins: readonly PublishPluginSpec[] | undefined;
  readonly analyzeCommits: Record<string, unknown> | undefined;
  readonly generateNotes: Record<string, unknown> | undefined;
}

function readReleaseConfigFile(path: string): ReleaseConfigFile {
  const parsed: unknown = parseJson(readFileSync(path, 'utf8'), '--config');
  if (!isJsonObject(parsed)) {
    throw new InvalidArgumentError(`--config file ${path} must contain a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_OPTION_KEYS.has(key)) {
      throw new InvalidArgumentError(`--config file ${path} has an unknown option "${key}"; recognised options: ${[...CONFIG_OPTION_KEYS].join(', ')}`);
    }
  }

  const { dryRun, branches, plugins, analyzeCommits, generateNotes } = parsed;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new InvalidArgumentError(`--config file ${path}: "dryRun" must be a boolean`);
  }
  if (branches !== undefined && !isStringArray(branches)) {
    throw new InvalidArgumentError(`--config file ${path}: "branches" must be an array of branch name strings`);
  }
  if (plugins !== undefined && !Array.isArray(plugins)) {
    throw new InvalidArgumentError(`--config file ${path}: "plugins" must be an array`);
  }
  if (analyzeCommits !== undefined && !isJsonObject(analyzeCommits)) {
    throw new InvalidArgumentError(`--config file ${path}: "analyzeCommits" must be an object`);
  }
  if (generateNotes !== undefined && !isJsonObject(generateNotes)) {
    throw new InvalidArgumentError(`--config file ${path}: "generateNotes" must be an object`);
  }

  return {
    dryRun,
    branches,
    plugins: plugins === undefined ? undefined : plugins.map((spec) => parseConfigFilePlugin(spec, path)),
    analyzeCommits,
    generateNotes,
  };
}

function parseConfigFilePlugin(spec: unknown, path: string): PublishPluginSpec {
  if (typeof spec === 'string') {
    return spec;
  }
  if (isPluginSpecTuple(spec)) {
    return spec;
  }
  throw new InvalidArgumentError(`--config file ${path}: each "plugins" entry must be a module name or a [name, config] array`);
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
