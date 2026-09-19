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
 * One workspace dependency range that changed because its package released a new version during this run. `rewritten` means the dependent's manifest was edited on disk; `resolved-at-publish` means a bare `workspace:^`-style range whose on-disk text is unchanged. Both count towards the dependent's release.
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
  bumpsFor: (dependent: string) => readonly DependencyBump[];
}

/** A publish-pipeline plugin entry as the orchestrator accepts it: a module name, optionally with a config object. */
export type PublishPluginSpec = string | readonly [string] | readonly [string, Record<string, unknown>];

/** Publish plugin lists keyed by package name. Each list replaces the workspace-wide list outright for that one package; it is not merged with it. */
export type PackagePluginSpecs = Readonly<Record<string, readonly PublishPluginSpec[]>>;

/** All resolving a package's publish plugins needs to know about it: its name, and whether its manifest marks it private. `WorkspacePackage` satisfies this structurally. */
export interface PublishPluginPackage {
  readonly name: string;
  readonly private: boolean;
}

/** The one plugin a private package is kept off by default: see `resolveWorkspacePublishPlugins` for why a package that never reaches a registry does not get a public GitHub Release either. */
const GITHUB_RELEASE_PLUGIN = '@semantic-release/github';

/** semantic-release's own `getLastRelease` returns `{}` for a package with no prior tag -- not `undefined`, and not a fully-populated `LastRelease` -- contradicting the `gitHead: string` its own type declares. Narrows structurally rather than trusting that declared type, so a first-release context's `lastRelease` (correctly, at runtime) never claims a `gitHead` it does not have. */
function hasGitHead(lastRelease: unknown): lastRelease is { readonly gitHead: string } {
  return typeof lastRelease === 'object' && lastRelease !== null && 'gitHead' in lastRelease && typeof lastRelease.gitHead === 'string';
}

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

/** The standard publish pipeline for `commitStrategy: 'single'`: the same as `DEFAULT_PUBLISH_PLUGINS` minus `@semantic-release/git`, which that mode never runs -- see `resolvePublishPlugins`'s `forbidGitPlugin` option for why it is rejected outright rather than merely unused. Single-commit mode does its own committing (one combined commit for every released package), so a `prepare`-step git plugin here would create the very per-package commits that mode exists to avoid. */
export const SINGLE_COMMIT_DEFAULT_PUBLISH_PLUGINS: readonly PublishPluginSpec[] = ['@semantic-release/changelog', '@semantic-release/npm', '@semantic-release/github'];

const STEP_PLUGINS_THE_ORCHESTRATOR_OWNS: ReadonlySet<string> = new Set(['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator']);

export interface ScopedPlugins {
  readonly analyzeCommits: (pluginConfig: Record<string, unknown>, context: AnalyzeCommitsContext & { cwd: string }) => Promise<string | false | undefined>;
  readonly generateNotes: (pluginConfig: Record<string, unknown>, context: GenerateNotesContext & { cwd: string }) => Promise<string | false | undefined>;
}

/**
 * Builds the per-package `analyzeCommits` and `generateNotes` functions handed to semantic-release as inline plugins.
 *
 * Both apply the same path scoping before delegating to the real `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator`: the commit list semantic-release already fetched for the release range is filtered down to commits whose `git log --name-only` file list intersects the package's own directory, and only the filtered list reaches the standard plugin. Conventional-commit parsing and changelog formatting stay entirely inside the standard plugins.
 *
 * The `analyzeCommits` wrapper carries one addition beyond filtering: when the standard analyzer finds no releasable commits but a workspace dependency range of the package's has changed, it returns 'patch' anyway. A dependent whose only change is a dependency bump still needs a release for that range to reach the registry. "Has changed" is read from two sources, merged: bumps recorded in memory earlier in the current run (`scope.bumps`), and bumps recorded in the package's own filtered commit history via the trailer `dependency-bump-commit.ts` writes and reads -- the latter is what lets a run that starts after a previous run already committed and pushed the bump (a crash recovery, or simply a later run) reach the same decision, rather than depending on state that existed only inside the process that made the commit.
 */
export function createScopedPlugins(scope: {
  readonly pkg: WorkspacePackage;
  readonly analyzeCommitsConfig: Record<string, unknown>;
  readonly generateNotesConfig: Record<string, unknown>;
  readonly bumps: DependencyBumpSource;
  /** Called with the path-filtered commit list every time this package's commits are resolved (from either step, whichever runs first). Optional: `commitStrategy: 'single'` uses it to capture the same filtered list `success()`'s GitHub plugin step needs later, without recomputing `changedPathsSince`/`filterCommitsToDirectory` itself from the outside. */
  readonly onCommitsResolved?: (commits: readonly Commit[]) => void;
}): ScopedPlugins {
  // One `git log --name-only` pass per release range, shared between the analyzeCommits and generateNotes steps (semantic-release calls both with the same lastRelease base; notes regeneration after a prepare-plugin commit reuses the cached range because the analysis list itself does not change).
  let cached: { readonly from: string | undefined; readonly paths: Promise<Map<string, ReadonlySet<string>>> } | undefined;

  async function commitsForPackage(context: AnalyzeCommitsContext & { cwd: string }): Promise<readonly Commit[]> {
    // A lastRelease with no gitHead means semantic-release fetched the package's whole history, so the path map is built over the same unbounded range.
    const from = hasGitHead(context.lastRelease) ? context.lastRelease.gitHead : undefined;
    // Two branches, not `cached === undefined || cached.from !== from`: when this is the very first call for a package with no prior release, both `cached` and `from` are `undefined`, and a single optional-chained comparison cannot distinguish "nothing cached yet" from "cached, and it happens to match".
    if (cached === undefined) {
      cached = { from, paths: changedPathsSince(from, { cwd: context.cwd }) };
    } else if (cached.from !== from) {
      cached = { from, paths: changedPathsSince(from, { cwd: context.cwd }) };
    }
    const commits = filterCommitsToDirectory(context.commits, await cached.paths, scope.pkg.repoRelativeDirectory);
    scope.onCommitsResolved?.(commits);
    return commits;
  }

  return {
    async analyzeCommits(_pluginConfig, context) {
      const commits = await commitsForPackage(context);
      const type = await analyzeCommits(scope.analyzeCommitsConfig, { ...context, commits });
      if (typeof type === 'string') {
        return type;
      }
      const bumps = mergeDependencyBumps(scope.bumps.bumpsFor(scope.pkg.name), commits);
      if (bumps.length === 0) {
        return false;
      }
      context.logger.log(
        `No releasable commits under ${scope.pkg.relativeDirectory}, but ${bumps.length === 1 ? 'a workspace dependency range changed' : `${String(bumps.length)} workspace dependency ranges changed`}; forcing a patch release.`,
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
      return typeof notes === 'string' ? `${notes}\n\n${section}` : section;
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
  options: { readonly requireGitPlugin: boolean; readonly forbidGitPlugin?: boolean },
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
      if (options.forbidGitPlugin === true) {
        throw new ReleaseConfigurationError(
          `"@semantic-release/git" is listed as a publish plugin, but commitStrategy "single" does its own committing -- one combined commit for every released package, tagged once every package has been analysed -- rather than letting each package's own release commit itself. Remove @semantic-release/git from the plugin list; its version bump and changelog write still happen (via its sibling prepare plugins), just folded into the combined commit instead of made on their own.`,
        );
      }
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
 * Resolves the publish plugin list of every package in the workspace: the workspace-wide list for each package, except where `packagePlugins` names a package, whose own list replaces it. Every list is held to the same rules as `resolvePublishPlugins` applies to a workspace-wide one, and a failure in an override names the package it belongs to.
 *
 * A package whose manifest sets `private: true` and which no `packagePlugins` entry names gets the workspace-wide list minus `@semantic-release/github`. A private package is never published, so a public GitHub Release for it advertises something nobody can install, and that release is not merely redundant: `@semantic-release/github` sets `make_latest` from the release branch alone, with no option to opt out, so every release it creates claims the repository's Latest label and the last one created keeps it. A private package sitting at the end of the topological order (which is where a package that depends on the published ones necessarily sits) therefore takes the label on every run. Everything the private package actually needs from the run is untouched: its version bump, its tag, and the dependency cascade to its dependents all come from the other plugins and from the orchestrator itself.
 *
 * A `packagePlugins` entry naming a private package is taken exactly as written, `@semantic-release/github` included, so a workspace that does want a Release for a private package can still say so.
 *
 * A `packagePlugins` key that matches no package is rejected rather than ignored: a misspelt name would otherwise leave the package it meant on the workspace-wide list with nothing to say so, which for the intended use (keeping a package out of a step such as GitHub Release creation) is a silent wrong result.
 */
export function resolveWorkspacePublishPlugins(
  packages: readonly PublishPluginPackage[],
  specs: { readonly plugins: readonly PublishPluginSpec[]; readonly packagePlugins: PackagePluginSpecs | undefined },
  workspaceRoot: string,
  options: { readonly requireGitPlugin: boolean; readonly forbidGitPlugin?: boolean },
): ReadonlyMap<string, readonly ResolvedPublishPlugin[]> {
  const overrides = specs.packagePlugins === undefined ? [] : Object.entries(specs.packagePlugins);

  const known = new Set(packages.map((pkg) => pkg.name));
  const unknown = overrides.map(([name]) => name).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new ReleaseConfigurationError(
      `packagePlugins names ${unknown.map((name) => `"${name}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not a package in this workspace. Packages: ${[...known].join(', ')}.`,
    );
  }

  const workspaceWide = resolvePublishPlugins(specs.plugins, workspaceRoot, options);
  const resolvedOverrides = new Map<string, readonly ResolvedPublishPlugin[]>();
  for (const [name, list] of overrides) {
    try {
      resolvedOverrides.set(name, resolvePublishPlugins(list, workspaceRoot, options));
    } catch (cause) {
      if (cause instanceof ReleaseConfigurationError) {
        throw new ReleaseConfigurationError(`packagePlugins for "${name}": ${cause.message}`);
      }
      throw cause;
    }
  }

  const privateSpecs = specs.plugins.filter((spec) => parsePublishPluginSpec(spec)[0] !== GITHUB_RELEASE_PLUGIN);
  // Resolved once for the whole workspace rather than per private package, and skipped altogether when the workspace-wide list creates no GitHub Release to begin with, in which case a private package's list is the workspace-wide one.
  const forPrivatePackages = privateSpecs.length === specs.plugins.length ? workspaceWide : resolvePublishPlugins(privateSpecs, workspaceRoot, options);

  return new Map(packages.map((pkg) => [pkg.name, resolvedOverrides.get(pkg.name) ?? (pkg.private ? forPrivatePackages : workspaceWide)]));
}

/**
 * Resolves a plugin module name to an absolute file path, first from this tool's own module context (its peer dependencies, which every workspace installing the orchestrator must provide) and then from the workspace root (a workspace's own plugin dependencies, such as a custom changelog plugin). Both bases are named in the error when neither can resolve the name.
 */
function resolvePluginModule(name: string, requireFromTool: NodeJS.Require, requireFromWorkspace: NodeJS.Require): string {
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
