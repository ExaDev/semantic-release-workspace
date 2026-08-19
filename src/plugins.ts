import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';
import type { AnalyzeCommitsContext, Commit, GenerateNotesContext } from 'semantic-release';
import { packageName } from './package-name';
import { parseDependencyBumpTrailer } from './dependency-bump-commit';
import { ReleaseConfigurationError } from './errors';
import { changedPathsSince } from './git';
import type { WorkspacePackage } from './workspace';

/**
 * One workspace dependency range that changed because its package released a new version during this run. `rewritten` means the dependent's manifest was edited on disk; `resolved-at-publish` means a `workspace:^`-style range whose on-disk text is unchanged but whose published value pnpm re-resolves at pack time. Both change the dependent's published artifact, which is why both count towards its release.
 */
export interface DependencyBump {
  readonly dependency: string;
  readonly version: string;
  /** The range as it now stands in the dependent's manifest -- the new concrete range for `rewritten`, the untouched `workspace:` range for `resolved-at-publish`. */
  readonly range: string;
  readonly kind: 'rewritten' | 'resolved-at-publish';
}

/** What the scoped plugins need to know about bumps recorded so far in the run, for the package they are about to analyse. */
export interface DependencyBumpSource {
  bumpsFor(dependent: string): readonly DependencyBump[];
}

/** A publish-pipeline plugin entry as the orchestrator accepts it: a module name, optionally with a config object. */
export type PublishPluginSpec = string | readonly [string] | readonly [string, Record<string, unknown>];

/** The standard publish pipeline this orchestrator coordinates when a workspace configures none of its own. Every entry reuses the corresponding official plugin -- the orchestrator scopes and sequences them per package, it does not reimplement npm publishing, GitHub release creation, or changelog writing. */
export const DEFAULT_PUBLISH_PLUGINS: readonly PublishPluginSpec[] = [
  '@semantic-release/changelog',
  '@semantic-release/npm',
  '@semantic-release/github',
  [
    '@semantic-release/git',
    {
      assets: ['CHANGELOG.md', 'package.json'],
      // nextRelease.gitTag is "<package name>@<version>" under this tool's tagFormat, so the release commit names the package it belongs to without needing anything beyond the standard template variables.
      message: 'chore(release): ${nextRelease.gitTag} [skip ci]',
    },
  ],
];

const STEP_PLUGINS_THE_ORCHESTRATOR_OWNS: ReadonlySet<string> = new Set(['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator']);

export interface ScopedPlugins {
  readonly analyzeCommits: (pluginConfig: Record<string, unknown>, context: AnalyzeCommitsContext & { cwd: string }) => Promise<string | false | undefined>;
  readonly generateNotes: (pluginConfig: Record<string, unknown>, context: GenerateNotesContext & { cwd: string }) => Promise<string | false | undefined>;
}

/**
 * Builds the per-package `analyzeCommits` and `generateNotes` functions handed to semantic-release as inline plugins.
 *
 * Both apply the same path scoping before delegating to the real @semantic-release/commit-analyzer and @semantic-release/release-notes-generator: the commit list semantic-release already fetched for the release range is filtered down to commits whose `git log --name-only` file list intersects the package's own directory, and only the filtered list reaches the standard plugin. Conventional-commit parsing and changelog formatting stay entirely inside the standard plugins.
 *
 * The `analyzeCommits` wrapper carries one addition beyond filtering: when the standard analyzer finds no releasable commits but a workspace dependency range of the package's has changed, it returns 'patch' anyway. A dependent whose only change is a dependency bump still needs a release for that range to reach the registry. "Has changed" is read from two sources, merged: bumps recorded in memory earlier in the current run (`scope.bumps`), and bumps recorded in the package's own filtered commit history via the trailer `dependency-bump-commit.ts` writes and reads -- the latter is what lets a run that starts after a previous run already committed and pushed the bump (a crash recovery, or simply a later run) reach the same decision, rather than depending on state that existed only inside the process that made the commit.
 */
export function createScopedPlugins(scope: {
  readonly pkg: WorkspacePackage;
  readonly analyzeCommitsConfig: Record<string, unknown>;
  readonly generateNotesConfig: Record<string, unknown>;
  readonly bumps: DependencyBumpSource;
}): ScopedPlugins {
  // One `git log --name-only` pass per release range, shared between the analyzeCommits and generateNotes steps (semantic-release calls both with the same lastRelease base; notes regeneration after a prepare-plugin commit reuses the cached range because the analysis list itself does not change).
  let cached: { readonly from: string | undefined; readonly paths: Promise<Map<string, ReadonlySet<string>>> } | undefined;

  async function commitsForPackage(context: AnalyzeCommitsContext & { cwd: string }): Promise<readonly Commit[]> {
    // An absent lastRelease means semantic-release fetched the package's whole history, so the path map is built over the same unbounded range.
    const from = context.lastRelease?.gitHead ?? undefined;
    if (cached?.from !== from) {
      cached = { from, paths: changedPathsSince(from, { cwd: context.cwd }) };
    }
    return filterCommitsToDirectory(context.commits, await cached.paths, scope.pkg.repoRelativeDirectory);
  }

  return {
    async analyzeCommits(_pluginConfig, context) {
      const commits = await commitsForPackage(context);
      const type = await analyzeCommits(scope.analyzeCommitsConfig, { ...context, commits });
      if (type) {
        return type;
      }
      const bumps = mergeDependencyBumps(scope.bumps.bumpsFor(scope.pkg.name), commits);
      if (bumps.length === 0) {
        return false;
      }
      context.logger.log(
        `No releasable commits under ${scope.pkg.relativeDirectory}, but ${bumps.length === 1 ? 'a workspace dependency range changed' : `${bumps.length} workspace dependency ranges changed`}; forcing a patch release.`,
      );
      return 'patch';
    },

    async generateNotes(_pluginConfig, context) {
      const commits = await commitsForPackage(context);
      const notes = await generateNotes(scope.generateNotesConfig, { ...context, commits });
      const bumps = mergeDependencyBumps(scope.bumps.bumpsFor(scope.pkg.name), commits);
      if (bumps.length === 0) {
        return notes;
      }
      const section = ['### Dependencies', '', ...bumps.map((bump) => describeDependencyBump(bump))].join('\n');
      return notes ? `${notes}\n\n${section}` : section;
    },
  };
}

/**
 * Combines the bumps recorded in memory earlier in the current run with bumps recovered from the package's own filtered commit history (a bump commit from this run, already visible because it touches the package's own directory, or one left over from a previous run), de-duplicated by dependency name. The in-memory entry wins on overlap: it carries the manifest field and dependent name a `resolved-at-publish` bump has no commit to recover from at all.
 */
function mergeDependencyBumps(runtimeBumps: readonly DependencyBump[], commits: readonly Commit[]): readonly DependencyBump[] {
  const byDependency = new Map<string, DependencyBump>();
  for (const commit of commits) {
    const parsed = parseDependencyBumpTrailer(commit.message);
    if (parsed !== undefined) {
      byDependency.set(parsed.dependency, { ...parsed, kind: 'rewritten' });
    }
  }
  for (const bump of runtimeBumps) {
    byDependency.set(bump.dependency, bump);
  }
  return [...byDependency.values()];
}

function describeDependencyBump(bump: DependencyBump): string {
  return bump.kind === 'rewritten'
    ? `- Updated ${bump.dependency} to ${bump.range}`
    : `- Updated ${bump.dependency} to ${bump.version} (declared as \`${bump.range}\`, resolved by pnpm at publish time)`;
}

/**
 * Keeps a commit for the package when any path it changed lies under the package's directory. The trailing-slash prefix comparison stops `packages/a` from matching `packages/abc/x`.
 *
 * A commit missing from the changed-paths map is kept rather than dropped: it is inside the package's release range (semantic-release put it there), so a failure to parse its file list must not silently swallow a release. Absent evidence errs towards publishing, which is the visible direction for a release tool.
 */
export function filterCommitsToDirectory<T extends { readonly hash: string }>(
  commits: readonly T[],
  changedPaths: ReadonlyMap<string, ReadonlySet<string>>,
  directory: string,
): readonly T[] {
  const prefix = `${directory}/`;
  return commits.filter((commit) => {
    const paths = changedPaths.get(commit.hash);
    if (paths === undefined) {
      return true;
    }
    return [...paths].some((path) => path === directory || path.startsWith(prefix));
  });
}

/** A publish plugin entry with its module name resolved to an absolute path, so semantic-release loads the workspace's installed plugins regardless of the package directory it runs from. */
export type ResolvedPublishPlugin = [string, Record<string, unknown>];

export function resolvePublishPlugins(
  specs: readonly PublishPluginSpec[],
  workspaceRoot: string,
  options: { readonly requireGitPlugin: boolean },
): readonly ResolvedPublishPlugin[] {
  const requireFromTool = createRequire(import.meta.url);
  const requireFromWorkspace = createRequire(resolve(workspaceRoot, 'package.json'));

  const resolved: ResolvedPublishPlugin[] = [];
  let hasGitPlugin = false;
  for (const spec of specs) {
    const [name, config] = parsePublishPluginSpec(spec);
    if (STEP_PLUGINS_THE_ORCHESTRATOR_OWNS.has(name)) {
      throw new ReleaseConfigurationError(
        `"${name}" is listed as a publish plugin, but ${packageName} always provides the ${name === '@semantic-release/commit-analyzer' ? 'analyzeCommits' : 'generateNotes'} step itself, wrapped around that plugin. Passing it here would make its configuration a silent no-op; set that configuration on the orchestrator's analyzeCommits/generateNotes options instead.`,
      );
    }
    if (name === '@semantic-release/git') {
      hasGitPlugin = true;
    }
    const entry: ResolvedPublishPlugin = [resolvePluginModule(name, requireFromTool, requireFromWorkspace), config];
    resolved.push(entry);
  }

  if (options.requireGitPlugin && !hasGitPlugin) {
    throw new ReleaseConfigurationError(
      `The publish plugin list does not include @semantic-release/git. Without it, nothing commits each released package's manifest and changelog back to the branch, so the repository would drift out of agreement with the published versions -- the exact divergence this tool exists to prevent. (Dry runs are exempt.)`,
    );
  }

  return resolved;
}

/**
 * Resolves a plugin module name to an absolute file path, first from this tool's own module context (its peer dependencies, which every workspace installing the orchestrator must provide) and then from the workspace root (a workspace's own plugin dependencies, such as a custom changelog plugin). Both bases are named in the error when neither can resolve the name.
 */
function resolvePluginModule(name: string, requireFromTool: NodeRequire, requireFromWorkspace: NodeRequire): string {
  const attempts: string[] = [];
  for (const [label, requirer] of [
    ['this tool', requireFromTool],
    ['the workspace root', requireFromWorkspace],
  ] as const) {
    try {
      return requirer.resolve(name);
    } catch (cause) {
      attempts.push(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new ReleaseConfigurationError(`Cannot resolve the publish plugin "${name}". Tried resolving it from ${attempts.join('; and from ')}.`);
}

export function parsePublishPluginSpec(spec: PublishPluginSpec): readonly [string, Record<string, unknown>] {
  if (typeof spec === 'string') {
    return [spec, {}];
  }
  const [name, config] = spec;
  return [name, config ?? {}];
}
