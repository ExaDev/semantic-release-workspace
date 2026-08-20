import { resolve } from 'node:path';
import semanticRelease from 'semantic-release';
import type { BranchSpec, Options, Result } from 'semantic-release';
import { formatDependencyBumpMessage } from './dependency-bump-commit';
import { WorkspaceReleaseError } from './errors';
import { commitFiles, pushHead, resolveCommitIdentity, type CommitIdentity } from './git';
import { buildDependencyGraph, topologicalOrder, type DependencyGraph } from './graph';
import { packageName } from './package-name';
import {
  type DependencyBump,
  DEFAULT_PUBLISH_PLUGINS,
  resolvePublishPlugins,
  type PublishPluginSpec,
  type ResolvedPublishPlugin,
  createScopedPlugins,
} from './plugins';
import { type DependencyField, writeDependencyRange } from './manifest';
import { regenerateLockfile } from './pnpm';
import { classifyDependencyRange, updateDependencyRange } from './version-range';
import { discoverWorkspace, type Workspace, type WorkspacePackage } from './workspace';

export interface ReleaseWorkspaceOptions {
  /** Directory holding the workspace's `pnpm-workspace.yaml`. Defaults to the process working directory. */
  readonly root?: string;
  /** Environment for the per-package semantic-release runs. Defaults to `process.env`; passing a copy lets tests and embedders control the CI detection semantic-release performs on it. */
  readonly env?: NodeJS.ProcessEnv;
  /** Passed straight through to every per-package semantic-release run: analysis runs, nothing is published, tagged, committed, or pushed. */
  readonly dryRun?: boolean;
  /** Release branch configuration for semantic-release. Defaults to semantic-release's own default branch list. */
  readonly branches?: readonly BranchSpec[];
  /** Publish-pipeline plugins (changelog, npm, GitHub, git), each scoped per package by semantic-release's own `cwd`. Defaults to the standard pipeline in DEFAULT_PUBLISH_PLUGINS. */
  readonly plugins?: readonly PublishPluginSpec[];
  /** Options for the wrapped @semantic-release/commit-analyzer, applied per package after path filtering. */
  readonly analyzeCommits?: Record<string, unknown>;
  /** Options for the wrapped @semantic-release/release-notes-generator, applied per package after path filtering. */
  readonly generateNotes?: Record<string, unknown>;
  /** Progress sink for the orchestrator's own narration (semantic-release logs its own detail). Defaults to `console.log`. */
  readonly log?: (message: string) => void;
}

/** One dependency-range change applied to a dependent package's manifest during the run, attached to the dependent's own outcome. */
export interface AppliedDependencyBump extends DependencyBump {
  readonly dependent: string;
  /** Which manifest field held the range that was rewritten. */
  readonly field: DependencyField;
}

export interface PackageReleaseOutcome {
  readonly name: string;
  readonly directory: string;
  readonly released: boolean;
  readonly version: string | undefined;
  readonly gitTag: string | undefined;
  /** The semantic-release release type ('minor', 'patch', ...), including the forced 'patch' of a dependency-bump-only release. */
  readonly type: string | undefined;
  /** Dependency ranges rewritten in this package's own manifest because a workspace dependency released earlier in the run. */
  readonly dependencyBumps: readonly AppliedDependencyBump[];
}

export interface WorkspaceReleaseOutcome {
  /** The topological order the packages were released in. */
  readonly order: readonly string[];
  readonly packages: readonly PackageReleaseOutcome[];
}

/**
 * Releases every package in a pnpm workspace with independent versions, in dependency order.
 *
 * For each package, in topological order: run semantic-release's programmatic API with `cwd` scoped to the package directory, a `name@version` tag format to keep each package's tags distinct in the one shared tag namespace, and inline `analyzeCommits`/`generateNotes` plugins that filter the release range's commits down to the package's own directory before delegating to the standard plugins. When a package releases, every workspace package that depends on it and has not run yet gets its dependency range rewritten in its manifest and committed immediately -- before its own turn, so its commit analysis and its published manifest both see the new range.
 */
export async function releaseWorkspace(options: ReleaseWorkspaceOptions = {}): Promise<WorkspaceReleaseOutcome> {
  const root = resolve(options.root ?? process.cwd());
  const log = options.log ?? console.log;
  const dryRun = options.dryRun === true;
  const env = options.env ?? process.env;

  const workspace = await discoverWorkspace(root);
  const graph = buildDependencyGraph(workspace.packages);
  validateDependencyRangeShapes(graph);
  const order = topologicalOrder(graph);
  log(`${packageName}: ${order.length} packages in release order: ${order.join(' -> ')}`);

  const publishPlugins = resolvePublishPlugins(options.plugins ?? DEFAULT_PUBLISH_PLUGINS, workspace.root, { requireGitPlugin: !dryRun });
  const analyzeCommitsConfig = options.analyzeCommits ?? {};
  const generateNotesConfig = options.generateNotes ?? {};

  // Bumps recorded for a dependent during the run; its scoped plugins read them to force a patch release and to add the dependency section to its notes, and the entry is consumed when its turn arrives.
  const pendingBumps = new Map<string, AppliedDependencyBump[]>();
  let identity: CommitIdentity | undefined;

  const outcomes: PackageReleaseOutcome[] = [];
  for (const name of order) {
    const pkg = mustGet(graph.packages, name, 'package');
    const bumpsForThisPackage = pendingBumps.get(name) ?? [];

    log(`Releasing ${name} from ${pkg.relativeDirectory}${bumpsForThisPackage.length > 0 ? ` (dependency ranges already bumped: ${bumpsForThisPackage.map((bump) => bump.dependency).join(', ')})` : ''}`);
    const result = await runPackageRelease(pkg, {
      publishPlugins,
      analyzeCommitsConfig,
      generateNotesConfig,
      bumpsForThisPackage,
      dryRun,
      env,
      branches: options.branches,
    });

    const nextRelease = result === false ? undefined : result.nextRelease;
    outcomes.push({
      name,
      directory: pkg.directory,
      released: nextRelease !== undefined,
      version: nextRelease?.version,
      gitTag: nextRelease?.gitTag,
      type: nextRelease?.type,
      dependencyBumps: bumpsForThisPackage,
    });
    pendingBumps.delete(name);

    if (nextRelease === undefined) {
      log(`${name}: no release`);
      continue;
    }
    log(`${name}: released ${nextRelease.gitTag}`);

    identity ??= await resolveCommitIdentity({ cwd: workspace.root });
    const bumps = await bumpDependents(pkg, nextRelease.version, graph, { workspace, dryRun, identity, log });
    for (const bump of bumps) {
      const forDependent = pendingBumps.get(bump.dependent) ?? [];
      forDependent.push(bump);
      pendingBumps.set(bump.dependent, forDependent);
    }
  }

  return { order, packages: outcomes };
}

/**
 * Checks every workspace dependency edge's range shape before anything releases, so an `UnsupportedDependencyRangeError` stops the run before the first publish rather than after some sibling has already been published, tagged, committed, and pushed. The shape a range supports depends only on the range text itself (see `classifyDependencyRange`), never on which version a sibling ends up releasing, so this can run once up front for the whole graph instead of only being discovered edge by edge as each dependency happens to release.
 */
function validateDependencyRangeShapes(graph: DependencyGraph): void {
  for (const edges of graph.dependencies.values()) {
    for (const edge of edges) {
      classifyDependencyRange(edge.range);
    }
  }
}

async function runPackageRelease(pkg: WorkspacePackage, options: {
  readonly publishPlugins: readonly ResolvedPublishPlugin[];
  readonly analyzeCommitsConfig: Record<string, unknown>;
  readonly generateNotesConfig: Record<string, unknown>;
  readonly bumpsForThisPackage: readonly AppliedDependencyBump[];
  readonly dryRun: boolean;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly branches: readonly BranchSpec[] | undefined;
}): Promise<Result> {
  const scoped = createScopedPlugins({
    pkg,
    analyzeCommitsConfig: options.analyzeCommitsConfig,
    generateNotesConfig: options.generateNotesConfig,
    bumps: { bumpsFor: () => options.bumpsForThisPackage },
  });

  const semanticReleaseOptions: Options = {
    // One tag namespace shared by every package: prefixing with the package name keeps each package's release tags (and the GitHub releases named after them) distinct and greppable.
    tagFormat: `${pkg.name}@` + '${version}',
    plugins: options.publishPlugins,
    analyzeCommits: scoped.analyzeCommits,
    generateNotes: scoped.generateNotes,
  };
  if (options.dryRun) {
    semanticReleaseOptions.dryRun = true;
  }
  if (options.branches !== undefined) {
    semanticReleaseOptions.branches = options.branches;
  }

  try {
    return await semanticRelease(semanticReleaseOptions, {
      cwd: pkg.directory,
      // A fresh copy per package: semantic-release mutates the env object it is given (setting GIT_AUTHOR_NAME and friends in CI mode), and that must not leak between packages or into the orchestrator's own git calls.
      env: { ...options.env },
    });
  } catch (cause) {
    throw new WorkspaceReleaseError(`Release of ${pkg.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The one filename pnpm recognises as its lockfile, always sitting beside `pnpm-workspace.yaml` at the workspace root regardless of which dependent's manifest a bump rewrites. */
const LOCKFILE_FILENAME = 'pnpm-lock.yaml';

/**
 * Rewrites the released package's range in every dependent's manifest, immediately after the release and before any dependent's own turn.
 *
 * The bump is committed (and pushed) right away rather than staged, because a dependent's semantic-release run analyses git history, not the working tree: an uncommitted bump would be invisible to its commit analysis, and would be stranded uncommitted if the dependent then released nothing -- a manifest that names versions the registry has never seen. Committing immediately means the dependent's own run sees the bump commit (it touches only the dependent's directory, so it passes that dependent's path filter), the forced-patch logic in the scoped analyzer covers the case where that bump is the dependent's only change, and a run interrupted partway leaves the remote describing exactly what was published. Pushing immediately mirrors what semantic-release itself does with release commits. The lockfile is regenerated (`pnpm install --lockfile-only`) and committed alongside the manifest for the same reason: a manifest bump committed without it leaves `pnpm-lock.yaml` naming the old range, which `pnpm install --frozen-lockfile` (what CI runs) then rejects.
 */
async function bumpDependents(released: WorkspacePackage, version: string, graph: DependencyGraph, options: {
  readonly workspace: Workspace;
  readonly dryRun: boolean;
  readonly identity: CommitIdentity;
  readonly log: (message: string) => void;
}): Promise<readonly AppliedDependencyBump[]> {
  const applied: AppliedDependencyBump[] = [];
  const dependents = graph.dependents.get(released.name);
  if (dependents === undefined) {
    return applied;
  }

  for (const edge of dependents) {
    const update = updateDependencyRange(edge.range, version);
    if (update.kind === 'wildcard') {
      continue;
    }

    const dependent = mustGet(graph.packages, edge.dependent, 'package');
    if (update.kind === 'rewritten') {
      if (!options.dryRun) {
        await writeDependencyRange(dependent.manifestPath, edge.field, released.name, update.range);
        // Regenerated before the commit below, not after, so the two file writes always land in the same commit -- see the lockfile paragraph in this function's own doc comment.
        await regenerateLockfile({ cwd: options.workspace.root });
        // The commit's message carries [skip ci] for the same reason semantic-release's own release commits do: pushing it must not trigger another CI release run that would race this one. It also carries a machine-parseable trailer (see dependency-bump-commit.ts) so a run that starts after this commit already exists in history -- including one recovering from a crash right after this push -- still recognises it as a dependency bump, rather than only a run that made the commit itself in memory recognising it.
        const message = formatDependencyBumpMessage({ dependency: released.name, version, range: update.range, dependent: edge.dependent });
        await commitFiles([`${dependent.relativeDirectory}/package.json`, LOCKFILE_FILENAME], message, { cwd: options.workspace.root, identity: options.identity });
        await pushHead({ cwd: options.workspace.root });
        options.log(`Bumped ${released.name} to ${update.range} in ${edge.dependent}, regenerated the lockfile, committed and pushed`);
      } else {
        options.log(`Would bump ${released.name} to ${update.range} in ${edge.dependent} (${edge.field})`);
      }
    } else {
      options.log(
        `${edge.dependent} declares ${released.name} as ${edge.range}; the manifest needs no edit, pnpm re-resolves it to ${version} at publish time`,
      );
    }
    applied.push({
      dependent: edge.dependent,
      dependency: released.name,
      field: edge.field,
      version,
      range: update.kind === 'rewritten' ? update.range : edge.range,
      kind: update.kind,
    });
  }
  return applied;
}

function mustGet<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new WorkspaceReleaseError(`Internal error: ${what} "${key}" disappeared from the dependency graph mid-run.`);
  }
  return value;
}
