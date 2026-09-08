import { resolve } from 'node:path';
import type { BranchSpec, Options } from 'semantic-release';
import { detachRelease, resumeRelease, type ReleaseGateState } from '@exadev/release-gate';
import { WorkspaceReleaseError } from './errors';
import { sanitizeGitEnv } from './git';
import { buildDependencyGraph, topologicalOrder, validateDependencyRangeShapes } from './graph';
import { isJsonObject, isUnknownArray } from './json';
import { packageName } from './package-name';
import { DEFAULT_PUBLISH_PLUGINS, resolvePublishPlugins, createScopedPlugins, type ResolvedPublishPlugin } from './plugins';
import { discoverWorkspace, type WorkspacePackage } from './workspace';
import {
  runReleaseLoop,
  type AppliedDependencyBump,
  type PackageReleaseOutcome,
  type ReleaseWorkspaceOptions,
  type WorkspaceReleaseOutcome,
} from './release';

/**
 * One package's outcome from a gated (`gatePublish: true`) detach pass -- what `resumeWorkspaceRelease` needs later to finish publishing it. `relativeDirectory`, not the absolute `directory`, is what a resume pass actually uses to resolve `cwd`: a resume can run against a different checkout of the same repository (a separate CI job, a separate clone) at a different absolute path, and `relativeDirectory` is the portable part.
 */
export interface DetachedPackageRelease {
  readonly name: string;
  readonly relativeDirectory: string;
  /** The state to hand `resumeRelease`, or `null` if this package had nothing to release. */
  readonly state: ReleaseGateState | null;
  readonly dependencyBumps: readonly AppliedDependencyBump[];
}

/**
 * The `gatePublish: true` half of `releaseWorkspace`: tags and pushes every due package via `@exadev/release-gate`'s `detachRelease`, but never publishes. Built on the same `runReleaseLoop` the normal per-package path uses, so dependency-range bumps between packages happen identically either way -- only the release call itself (`detachRelease` instead of `semanticRelease`) and how "did it release" gets read differ.
 */
export async function detachWorkspaceRelease(options: ReleaseWorkspaceOptions): Promise<WorkspaceReleaseOutcome> {
  const root = resolve(options.root ?? process.cwd());
  const log = options.log ?? console.log;
  const dryRun = options.dryRun === true;
  const env = sanitizeGitEnv(options.env ?? process.env);

  const workspace = await discoverWorkspace(root);
  const graph = buildDependencyGraph(workspace.packages);
  validateDependencyRangeShapes(graph);
  const order = topologicalOrder(graph);
  log(`${packageName}: ${order.length} packages in release order (gated -- tag only, publish deferred): ${order.join(' -> ')}`);

  const publishPlugins = resolvePublishPlugins(options.plugins ?? DEFAULT_PUBLISH_PLUGINS, workspace.root, { requireGitPlugin: !dryRun });
  const analyzeCommitsConfig = options.analyzeCommits ?? {};
  const generateNotesConfig = options.generateNotes ?? {};

  const entries = await runReleaseLoop(graph, order, workspace, dryRun, log, async (pkg, bumpsForThisPackage) => {
    const state = await runPackageDetach(pkg, {
      publishPlugins,
      analyzeCommitsConfig,
      generateNotesConfig,
      bumpsForThisPackage,
      dryRun,
      env,
      branches: options.branches,
    });
    return { released: state !== null, version: state?.nextRelease.version, result: state };
  });

  const packages: PackageReleaseOutcome[] = entries.map((entry) => ({
    name: entry.name,
    directory: entry.directory,
    released: entry.result !== null,
    version: entry.result?.nextRelease.version,
    gitTag: entry.result?.nextRelease.gitTag,
    type: entry.result?.nextRelease.type,
    dependencyBumps: entry.dependencyBumps,
  }));

  const detached: DetachedPackageRelease[] = entries.map((entry) => ({
    name: entry.name,
    relativeDirectory: entry.relativeDirectory,
    state: entry.result,
    dependencyBumps: entry.dependencyBumps,
  }));

  return { order, packages, detached };
}

async function runPackageDetach(
  pkg: WorkspacePackage,
  options: {
    readonly publishPlugins: readonly ResolvedPublishPlugin[];
    readonly analyzeCommitsConfig: Record<string, unknown>;
    readonly generateNotesConfig: Record<string, unknown>;
    readonly bumpsForThisPackage: readonly AppliedDependencyBump[];
    readonly dryRun: boolean;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly branches: readonly BranchSpec[] | undefined;
  },
): Promise<ReleaseGateState | null> {
  const scoped = createScopedPlugins({
    pkg,
    analyzeCommitsConfig: options.analyzeCommitsConfig,
    generateNotesConfig: options.generateNotesConfig,
    bumps: { bumpsFor: () => options.bumpsForThisPackage },
  });

  const cliOptions: Options = {
    tagFormat: `${pkg.name}@` + '${version}',
    plugins: options.publishPlugins,
    analyzeCommits: scoped.analyzeCommits,
    generateNotes: scoped.generateNotes,
  };
  if (options.dryRun) {
    cliOptions.dryRun = true;
  }
  if (options.branches !== undefined) {
    cliOptions.branches = options.branches;
  }

  try {
    return await detachRelease(cliOptions, {
      cwd: pkg.directory,
      // A fresh copy per package, matching runPackageRelease's own env handling in release.ts -- see that function's comment for why.
      env: { ...options.env },
    });
  } catch (cause) {
    throw new WorkspaceReleaseError(`Detaching ${pkg.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Runtime guard for a `DetachedPackageRelease[]` read back off disk (the CLI's `resume` subcommand reads `WorkspaceReleaseOutcome.detached` from a JSON file `release --gate-publish` wrote) -- `JSON.parse` returns `any`, so this is the boundary that turns it back into something safe to pass to `resumeWorkspaceRelease`. Only checks the outer shape (`name`, `relativeDirectory`, `dependencyBumps`, and that `state` is either `null` or an object); `state`'s own inner shape is validated by `@exadev/release-gate`'s `resumeRelease` itself, once per entry, which is where a genuinely malformed state fails loudly with a specific error rather than here.
 */
export function isDetachedPackageReleaseArray(value: unknown): value is readonly DetachedPackageRelease[] {
  if (!isUnknownArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (!isJsonObject(entry)) {
      return false;
    }
    if (typeof entry.name !== 'string' || typeof entry.relativeDirectory !== 'string') {
      return false;
    }
    if (entry.state !== null && !isJsonObject(entry.state)) {
      return false;
    }
    return isUnknownArray(entry.dependencyBumps);
  });
}

export interface ResumeWorkspaceReleaseOptions {
  /** Directory holding the workspace's `pnpm-workspace.yaml` in *this* checkout -- not necessarily the same absolute path the detach pass ran from. Defaults to the process working directory. */
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** `WorkspaceReleaseOutcome.detached` from the earlier `releaseWorkspace({gatePublish: true})` call this resumes. */
  readonly detached: readonly DetachedPackageRelease[];
  readonly log?: (message: string) => void;
}

/**
 * Finishes every package a `gatePublish: true` `releaseWorkspace` run tagged and pushed but did not publish. Resumes each `detached` entry in the array's own order -- not re-derived from the workspace's dependency graph, since a resume pass may run in a separate process or checkout, where re-deriving order should only ever matter for directory lookup, not sequencing.
 */
export async function resumeWorkspaceRelease(options: ResumeWorkspaceReleaseOptions): Promise<WorkspaceReleaseOutcome> {
  const root = resolve(options.root ?? process.cwd());
  const log = options.log ?? console.log;
  const env = sanitizeGitEnv(options.env ?? process.env);

  const order: string[] = [];
  const packages: PackageReleaseOutcome[] = [];

  for (const entry of options.detached) {
    order.push(entry.name);

    if (entry.state === null) {
      log(`${entry.name}: no release to resume`);
      packages.push({
        name: entry.name,
        directory: resolve(root, entry.relativeDirectory),
        released: false,
        version: undefined,
        gitTag: undefined,
        type: undefined,
        dependencyBumps: entry.dependencyBumps,
      });
      continue;
    }

    const directory = resolve(root, entry.relativeDirectory);
    log(`Resuming ${entry.name} from ${entry.relativeDirectory}`);
    let releases: readonly unknown[];
    try {
      releases = await resumeRelease(entry.state, { cwd: directory, env: { ...env } });
    } catch (cause) {
      throw new WorkspaceReleaseError(`Resuming ${entry.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    log(`${entry.name}: published ${entry.state.nextRelease.gitTag} (${releases.length} publish plugin${releases.length === 1 ? '' : 's'} ran)`);

    packages.push({
      name: entry.name,
      directory,
      released: true,
      version: entry.state.nextRelease.version,
      gitTag: entry.state.nextRelease.gitTag,
      type: entry.state.nextRelease.type,
      dependencyBumps: entry.dependencyBumps,
    });
  }

  return { order, packages };
}
