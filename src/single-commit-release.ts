import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semanticRelease from 'semantic-release';
import type { AnalyzeCommitsContext, BranchObject, BranchSpec, Commit, Options, ReleaseType } from 'semantic-release';
import { GitCommandError, ReleaseConfigurationError, WorkspaceStateError } from './errors';
import {
  assertCleanWorkingTree,
  commitFiles,
  createTag,
  currentBranch,
  deleteLocalTags,
  fetchBranchTip,
  git,
  isAncestor,
  pushHeadAndTags,
  resetHardTo,
  resolveCommitIdentity,
  sanitizeGitEnv,
  workingTreeChanges,
} from './git';
import { buildDependencyGraph, mustGet, orderedPackages, topologicalOrder, validateDependencyRanges, type DependencyGraph } from './graph';
import { writeDependencyRange } from './manifest';
import { packageName } from './package-name';
import { createScopedPlugins, resolveWorkspacePublishPlugins, SINGLE_COMMIT_DEFAULT_PUBLISH_PLUGINS, type ResolvedPublishPlugin } from './plugins';
import { regenerateLockfile } from './pnpm';
import { DEFAULT_PUSH_ATTEMPTS, type AppliedDependencyBump, type PackageReleaseOutcome, type ReleaseWorkspaceOptions, type WorkspaceReleaseOutcome } from './release';
import { updateDependencyRange } from './version-range';
import { discoverWorkspace, type WorkspacePackage } from './workspace';
import { DEFAULT_TAG_FORMAT, formatTagForPackage, validateTagFormat } from './tag-format';

/**
 * `commitStrategy: 'single'`: one combined commit for the whole run instead of one commit per package release plus one per dependency bump.
 *
 * Five phases, all inside one `releaseWorkspaceSingleCommit` call:
 *
 * 1. **Analyse** (this file's `analysePackage`): for every package, in topological order, run semantic-release with `dryRun: true` forced (regardless of the caller's own `dryRun` option) using the same path-scoped `analyzeCommits`/`generateNotes` wrapper `commitStrategy: 'per-package'` uses -- computing each package's next version and notes without writing, committing, tagging, or publishing anything. Cross-package dependency bumps are tracked purely in memory during this phase (`pendingBumps`), exactly as the per-package strategy tracks them for the span of one run; nothing is committed yet for a later run to recover from, because this strategy never leaves a partial commit for a crash to recover from in the first place -- either the whole combined commit lands, or nothing does.
 * 2. **Verify** every released package's configured publish plugins' `verifyConditions` step (npm registry auth, GitHub token/repo access), before any file is written -- the same fail-fast-before-anything-releases discipline `validateDependencyRanges` already applies to dependency ranges.
 * 3. **Prepare**: for every released package, in topological order, apply any dependency-range bump its own manifest received (writing `package.json` directly, the same `writeDependencyRange` the per-package strategy uses), then run every configured publish plugin's own `prepare` step generically (whichever it defines -- `@semantic-release/npm` bumps `package.json`'s version, `@semantic-release/changelog` writes `CHANGELOG.md`). `@semantic-release/git` is rejected outright from this mode's plugin list (see `resolvePublishPlugins`'s `forbidGitPlugin`), since its own `prepare` step would create exactly the per-package commit this mode exists to avoid. The lockfile is regenerated once at the end, not once per bump, since `pnpm install --lockfile-only` recomputes it from whatever is on disk regardless of how many manifests changed.
 * 4. **Commit**: discover every file phase 3 touched via `git status` (rather than predicting filenames per plugin), make one commit, tag it once per released package (`name@version`, lightweight, matching semantic-release's own tag form), and push the commit and every tag together.
 * 5. **Publish**: for every released package, in topological order, call each configured plugin's own `publish` step directly (not through semantic-release's top-level orchestrator -- see the note below), then `success`.
 *
 * Why publish is not just another semantic-release() call: semantic-release's own `run()` unconditionally derives `lastRelease` from the newest tag already on the branch matching `tagFormat`, and this mode has, by the time phase 5 runs, already created and pushed that exact tag itself. A second real `semanticRelease()` call would see its own just-created tag as the already-published release and compute the wrong next version from it. Phase 5 instead calls each resolved plugin module's own exported `verifyConditions`/`publish`/`success` functions directly, with a hand-built context -- the same public per-plugin API surface semantic-release's own core calls internally, just invoked without going through the parts of `run()` that assume a not-yet-tagged repository.
 */
export async function releaseWorkspaceSingleCommit(options: ReleaseWorkspaceOptions): Promise<WorkspaceReleaseOutcome> {
  const log = options.log ?? console.log;
  const maxAttempts = resolvePushAttempts(options.pushAttempts);
  let lastLoss: GitCommandError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptSingleCommitRelease(options);
    if (result.kind === 'complete') {
      return result.outcome;
    }
    if (result.kind === 'pushed') {
      await result.publish();
      return result.outcome;
    }
    lastLoss = result.error;
    log(
      `${packageName}: attempt ${String(attempt)} of ${String(maxAttempts)} lost the push, because ${result.branch} advanced to ${result.remoteTip} before this run's own refs reached the remote. This attempt's commit and tags have been discarded; recomputing the release against the new tip.`,
    );
  }

  throw new WorkspaceStateError(
    `${packageName}: gave up after ${String(maxAttempts)} attempt(s) to push the release, each overtaken by another commit landing on the release branch first. Nothing was published and no tag reached the remote, so re-running is safe and loses nothing. Raise "pushAttempts" if this branch is busy enough that ${String(maxAttempts)} is genuinely too few. The last push failed with: ${lastLoss === undefined ? 'unknown' : lastLoss.message}`,
  );
}

function resolvePushAttempts(configured: number | undefined): number {
  if (configured === undefined) {
    return DEFAULT_PUSH_ATTEMPTS;
  }
  if (!Number.isInteger(configured) || configured < 1) {
    throw new ReleaseConfigurationError(`"pushAttempts" must be a positive integer; received ${String(configured)}.`);
  }
  return configured;
}

/**
 * One attempt's outcome. `lost` is the only retriable one, and reaching it means the attempt has already put the checkout back where a fresh attempt can start: its commit and tags are gone and the branch sits on the remote's current tip.
 *
 * `pushed` hands back a `publish` callback rather than publishing itself, so that phase 5 stays outside the retry loop by construction. Publishing is the one step that cannot be undone, and the type makes it unreachable until a push has actually succeeded.
 */
type SingleCommitAttempt =
  | { readonly kind: 'complete'; readonly outcome: WorkspaceReleaseOutcome }
  | { readonly kind: 'pushed'; readonly outcome: WorkspaceReleaseOutcome; readonly publish: () => Promise<void> }
  | { readonly kind: 'lost'; readonly error: GitCommandError; readonly branch: string; readonly remoteTip: string };

async function attemptSingleCommitRelease(options: ReleaseWorkspaceOptions): Promise<SingleCommitAttempt> {
  const root = resolve(options.root ?? process.cwd());
  const log = options.log ?? console.log;
  const dryRun = options.dryRun === true;
  // Sanitized once here, not per call: every downstream use (semantic-release's own analysis/publish subprocess calls, and the hand-built plugin contexts in phase 5) shares this one environment, so a GIT_DIR this process itself inherited from an outer git hook cannot leak into any of them.
  const env = sanitizeGitEnv(options.env ?? process.env);

  const workspace = await discoverWorkspace(root);
  const repoRoot = (await git(['rev-parse', '--show-toplevel'], { cwd: workspace.root })).trim();
  await assertCleanWorkingTree({ cwd: repoRoot });

  const graph = buildDependencyGraph(workspace.packages);
  validateDependencyRanges(graph);
  const order = topologicalOrder(graph);
  log(`${packageName}: ${String(order.length)} packages in release order: ${order.join(' -> ')} (commitStrategy: single)`);

  const resolvedPlugins = resolveWorkspacePublishPlugins(
    orderedPackages(graph, order),
    { plugins: options.plugins ?? SINGLE_COMMIT_DEFAULT_PUBLISH_PLUGINS, packagePlugins: options.packagePlugins },
    workspace.root,
    { requireGitPlugin: false, forbidGitPlugin: true },
  );
  const analyzeCommitsConfig = options.analyzeCommits ?? {};
  const generateNotesConfig = options.generateNotes ?? {};
  const tagFormat = validateTagFormat(options.tagFormat ?? DEFAULT_TAG_FORMAT);

  const capturedCommits = new Map<string, readonly Commit[]>();
  const captured: { branch: BranchObject | undefined; repositoryUrl: string | undefined } = { branch: undefined, repositoryUrl: undefined };
  const pendingBumps = new Map<string, AppliedDependencyBump[]>();

  const outcomes: PackageReleaseOutcome[] = [];
  const planned: PlannedPackageRelease[] = [];

  for (const name of order) {
    const pkg = mustGet(graph.packages, name, 'package');
    const bumpsForThisPackage = pendingBumps.get(name) ?? [];
    pendingBumps.delete(name);

    const nextRelease = await analysePackage(pkg, {
    tagFormat,
      resolvedPlugins: mustGet(resolvedPlugins, name, 'publish plugins'),
      analyzeCommitsConfig,
      generateNotesConfig,
      bumpsForThisPackage,
      env,
      branches: options.branches,
      onCommitsResolved: (commits) => {
        capturedCommits.set(name, commits);
      },
      onContextCaptured: (context) => {
        captured.branch = context.branch;
        captured.repositoryUrl = context.repositoryUrl;
      },
    });

    outcomes.push(
      nextRelease === undefined
        ? { name, directory: pkg.directory, released: false, dependencyBumps: bumpsForThisPackage }
        : {
            name,
            directory: pkg.directory,
            released: true,
            version: nextRelease.version,
            gitTag: nextRelease.gitTag,
            type: nextRelease.type,
            dependencyBumps: bumpsForThisPackage,
          },
    );

    if (nextRelease === undefined) {
      log(`${name}: no release`);
      continue;
    }
    log(`${name}: would release ${nextRelease.gitTag}`);
    planned.push({ pkg, type: nextRelease.type, version: nextRelease.version, gitTag: nextRelease.gitTag, notes: nextRelease.notes, bumps: bumpsForThisPackage });

    for (const bump of planDependentBumps(pkg, nextRelease.version, graph)) {
      const forDependent = pendingBumps.get(bump.dependent) ?? [];
      forDependent.push(bump);
      pendingBumps.set(bump.dependent, forDependent);
    }
  }

  if (dryRun || planned.length === 0) {
    return { kind: 'complete', outcome: { order, packages: outcomes } };
  }

  const branch = captured.branch;
  const repositoryUrl = captured.repositoryUrl;
  if (branch === undefined || repositoryUrl === undefined) {
    throw new ReleaseConfigurationError(
      `Internal error: ${packageName} analysed ${String(planned.length)} package release(s) but never captured a branch/repositoryUrl from semantic-release's own context. This should be impossible when at least one package releases.`,
    );
  }

  const shared: SharedRunContext = { env, branch, repositoryUrl, log };
  const moduleCache = new Map<string, LoadedReleasePlugin>();

  // Phase 2: verify every released package's publish plugins before writing anything.
  for (const release of planned) {
    for (const [modulePath, pluginConfig] of mustGet(resolvedPlugins, release.pkg.name, 'publish plugins')) {
      const plugin = await loadReleasePlugin(modulePath, moduleCache);
      if (plugin.verifyConditions) {
        await plugin.verifyConditions(pluginConfig, buildPluginContext(release, shared, capturedCommits, []));
      }
    }
  }

  // Phase 3: apply dependency bumps and run every configured plugin's own prepare step, per released package.
  let anyRangeRewritten = false;
  for (const release of planned) {
    for (const bump of release.bumps) {
      if (bump.kind !== 'rewritten') {
        continue;
      }
      await writeDependencyRange(release.pkg.manifestPath, bump.field, bump.dependency, bump.range);
      anyRangeRewritten = true;
    }
    for (const [modulePath, pluginConfig] of mustGet(resolvedPlugins, release.pkg.name, 'publish plugins')) {
      const plugin = await loadReleasePlugin(modulePath, moduleCache);
      if (plugin.prepare) {
        await plugin.prepare(pluginConfig, buildPluginContext(release, shared, capturedCommits, []));
      }
    }
  }
  if (anyRangeRewritten) {
    await regenerateLockfile({ cwd: workspace.root });
  }

  // Phase 4: one commit, one tag per released package, one push.
  const touchedPaths = await workingTreeChanges({ cwd: repoRoot });
  if (touchedPaths.length === 0) {
    throw new ReleaseConfigurationError(
      `${packageName}: analysis planned ${String(planned.length)} release(s), but no files changed while preparing them. Every configured publish plugin's own "prepare" step (bumping package.json, writing CHANGELOG.md) produced nothing to commit -- check the plugin list includes something that writes the version, e.g. @semantic-release/npm.`,
    );
  }
  const identity = await resolveCommitIdentity({ cwd: repoRoot });
  await commitFiles(touchedPaths, describeCombinedCommit(planned), { cwd: repoRoot, identity });
  const commitSha = (await git(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
  const tagNames = planned.map((release) => release.gitTag);
  for (const tagName of tagNames) {
    await createTag(tagName, commitSha, { cwd: repoRoot });
  }
  const branchName = await currentBranch({ cwd: repoRoot });
  try {
    await pushHeadAndTags(tagNames, { cwd: repoRoot });
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
    // Whether this is a race is a question about the remote, not about the words git chose for the rejection: if the branch's current tip is still reachable from this attempt's HEAD then the push would have fast-forwarded, so something other than a competing commit refused it (a pre-receive hook, a ruleset, a protected branch) and repeating the attempt would only fail the same way.
    let remoteTip: string;
    try {
      remoteTip = await fetchBranchTip(branchName, { cwd: repoRoot });
    } catch {
      // The remote cannot be reached at all, so the push failure is the real problem and is the one worth reporting, not this secondary symptom of it.
      throw error;
    }
    if (await isAncestor(remoteTip, 'HEAD', { cwd: repoRoot })) {
      throw error;
    }
    // Nothing has published yet, and `--atomic` means no tag reached the remote, so this attempt can be discarded outright. Tags go first: `git tag` refuses a name that already exists, so leaving them would make the next attempt fail while tagging rather than while pushing.
    await deleteLocalTags(tagNames, { cwd: repoRoot });
    await resetHardTo(remoteTip, { cwd: repoRoot });
    return { kind: 'lost', error, branch: branchName, remoteTip };
  }
  log(`${packageName}: committed ${commitSha} and pushed ${String(tagNames.length)} tag(s): ${tagNames.join(', ')}`);

  return {
    kind: 'pushed',
    outcome: { order, packages: outcomes },
    // Phase 5: publish, then success, per released package. Deliberately a callback the caller invokes only once the push above has landed, so no retry path can ever reach it.
    publish: async () => {
      for (const release of planned) {
        const releases: unknown[] = [];
        for (const [modulePath, pluginConfig] of mustGet(resolvedPlugins, release.pkg.name, 'publish plugins')) {
          const plugin = await loadReleasePlugin(modulePath, moduleCache);
          if (plugin.publish) {
            const result = await plugin.publish(pluginConfig, buildPluginContext(release, shared, capturedCommits, releases));
            if (result !== false && result !== undefined) {
              releases.push(result);
            }
          }
        }
        for (const [modulePath, pluginConfig] of mustGet(resolvedPlugins, release.pkg.name, 'publish plugins')) {
          const plugin = await loadReleasePlugin(modulePath, moduleCache);
          if (plugin.success) {
            await plugin.success(pluginConfig, buildPluginContext(release, shared, capturedCommits, releases));
          }
        }
        log(`${release.pkg.name}: published ${release.gitTag}`);
      }
    },
  };
}

interface PlannedPackageRelease {
  readonly pkg: WorkspacePackage;
  readonly type: ReleaseType;
  readonly version: string;
  readonly gitTag: string;
  readonly notes: string;
  readonly bumps: readonly AppliedDependencyBump[];
}

interface AnalysedNextRelease {
  readonly type: ReleaseType;
  readonly version: string;
  readonly gitTag: string;
  readonly notes: string;
}

/**
 * Runs one package's analysis with semantic-release's own real `dryRun: true` mode (which still fully computes `nextRelease.version`/`notes` and the branch/repository context; only the plugin steps whose own definition opts out of dry runs -- prepare, publish, addChannel, success, fail -- are skipped), using the exact same path-scoped `analyzeCommits`/`generateNotes` wrapper `commitStrategy: 'per-package'` uses. `dryRun: true` is forced here regardless of the caller's own `dryRun` option: this is always how phase 1 computes what *would* release, whether or not the run goes on to actually commit it.
 */
async function analysePackage(pkg: WorkspacePackage, options: {
  readonly tagFormat: string;
  readonly resolvedPlugins: readonly ResolvedPublishPlugin[];
  readonly analyzeCommitsConfig: Record<string, unknown>;
  readonly generateNotesConfig: Record<string, unknown>;
  readonly bumpsForThisPackage: readonly AppliedDependencyBump[];
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly branches: readonly BranchSpec[] | undefined;
  readonly onCommitsResolved: (commits: readonly Commit[]) => void;
  readonly onContextCaptured: (context: { branch: BranchObject; repositoryUrl: string }) => void;
}): Promise<AnalysedNextRelease | undefined> {
  const scoped = createScopedPlugins({
    pkg,
    analyzeCommitsConfig: options.analyzeCommitsConfig,
    generateNotesConfig: options.generateNotesConfig,
    bumps: { bumpsFor: () => options.bumpsForThisPackage },
    onCommitsResolved: options.onCommitsResolved,
  });

  const semanticReleaseOptions: Options = {
    tagFormat: formatTagForPackage(options.tagFormat, pkg.name),
    plugins: options.resolvedPlugins,
    dryRun: true,
    async analyzeCommits(pluginConfig: Record<string, unknown>, context: AnalyzeCommitsContext & { cwd: string }): Promise<string | false | undefined> {
      if (context.options.repositoryUrl === undefined) {
        throw new ReleaseConfigurationError('Internal error: semantic-release did not resolve a repository URL before analyzeCommits ran.');
      }
      options.onContextCaptured({ branch: context.branch, repositoryUrl: context.options.repositoryUrl });
      return scoped.analyzeCommits(pluginConfig, context);
    },
    generateNotes: scoped.generateNotes,
  };
  if (options.branches !== undefined) {
    semanticReleaseOptions.branches = options.branches;
  }

  const result = await semanticRelease(semanticReleaseOptions, { cwd: pkg.directory, env: { ...options.env } });
  if (result === false) {
    return undefined;
  }
  if (result.nextRelease.notes === undefined) {
    throw new ReleaseConfigurationError(`Internal error: ${pkg.name} released with no notes computed.`);
  }
  return { type: result.nextRelease.type, version: result.nextRelease.version, gitTag: result.nextRelease.gitTag, notes: result.nextRelease.notes };
}

/** Pure classification of what a released package's version does to each dependent's declared range -- the same logic `bumpDependents` in `release.ts` applies, minus the file write/commit/push: `commitStrategy: 'single'` defers every write to phase 3, applying the same classification once analysis has finished for the whole run. */
function planDependentBumps(released: WorkspacePackage, version: string, graph: DependencyGraph): readonly AppliedDependencyBump[] {
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

function describeCombinedCommit(planned: readonly PlannedPackageRelease[]): string {
  const lines = planned.map((release) => {
    const bumpDescriptions = release.bumps.map((bump) => `${bump.dependency} to ${bump.range}`);
    const bumpSuffix = bumpDescriptions.length === 0 ? '' : ` (dependenc${bumpDescriptions.length === 1 ? 'y' : 'ies'} bumped: ${bumpDescriptions.join(', ')})`;
    return `- ${release.gitTag} (${release.type})${bumpSuffix}`;
  });
  return ['chore(release): batch release [skip ci]', '', ...lines].join('\n');
}

/** The subset of a semantic-release plugin context this mode's own hand-built calls actually construct and pass, covering exactly the fields the `verifyConditions`/`prepare`/`publish`/`success` steps of `@semantic-release/changelog`, `@semantic-release/npm`, and `@semantic-release/github` read (confirmed by reading each plugin's own source) -- not the full upstream `VerifyReleaseContext` shape, most of which (`envCi`, `branches` plural, `lastRelease`) none of those steps consult. */
interface PluginCallContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly logger: PluginLogger;
  readonly options: { readonly repositoryUrl: string };
  readonly branch: BranchObject;
  readonly commits: readonly Commit[];
  readonly releases: readonly unknown[];
  readonly nextRelease: {
    readonly type: ReleaseType;
    readonly version: string;
    readonly gitTag: string;
    readonly name: string;
    readonly notes: string;
    readonly channel: string | null;
  };
}

interface PluginLogger {
  readonly log: (...args: readonly unknown[]) => void;
  readonly warn: (...args: readonly unknown[]) => void;
  readonly error: (...args: readonly unknown[]) => void;
  readonly success: (...args: readonly unknown[]) => void;
}

interface SharedRunContext {
  readonly env: NodeJS.ProcessEnv;
  readonly branch: BranchObject;
  readonly repositoryUrl: string;
  readonly log: (message: string) => void;
}

function buildPluginContext(
  release: PlannedPackageRelease,
  shared: SharedRunContext,
  capturedCommits: ReadonlyMap<string, readonly Commit[]>,
  releases: readonly unknown[],
): PluginCallContext {
  const logger: PluginLogger = {
    log: (...args) => { shared.log(`[${release.pkg.name}] ${args.map(String).join(' ')}`); },
    warn: (...args) => { shared.log(`[${release.pkg.name}] warn: ${args.map(String).join(' ')}`); },
    error: (...args) => { shared.log(`[${release.pkg.name}] error: ${args.map(String).join(' ')}`); },
    success: (...args) => { shared.log(`[${release.pkg.name}] ${args.map(String).join(' ')}`); },
  };
  return {
    cwd: release.pkg.directory,
    env: { ...shared.env },
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
    options: { repositoryUrl: shared.repositoryUrl },
    branch: shared.branch,
    commits: capturedCommits.get(release.pkg.name) ?? [],
    releases,
    nextRelease: {
      type: release.type,
      version: release.version,
      gitTag: release.gitTag,
      name: release.gitTag,
      notes: release.notes,
      channel: channelOrNull(shared.branch.channel),
    },
  };
}

/** Matches semantic-release's own core exactly (`context.branch.channel || null` in its `index.js`): a branch's `channel` is `string | false | undefined`, and any falsy value (including `false` and an empty string) means "the default channel", represented here as `null`. Written as explicit comparisons rather than `||`/`??` so the falsy-to-null collapse (deliberately including `false` and `''`, which `??` alone would not fold) reads as intentional rather than as a fallback for `undefined`/`null` alone. */
function channelOrNull(channel: string | false | undefined): string | null {
  return channel === undefined || channel === false || channel === '' ? null : channel;
}

type ReleaseLifecycleFn = (pluginConfig: Record<string, unknown>, context: PluginCallContext) => Promise<unknown>;

/** The shape of a dynamically-imported publish-plugin module, as far as `commitStrategy: 'single'` calls it directly: whichever of these four named exports it happens to define (the same generic, plugin-agnostic dispatch semantic-release's own core uses -- it does not hardcode which named plugin defines which step either). */
interface LoadedReleasePlugin {
  readonly verifyConditions?: ReleaseLifecycleFn;
  readonly prepare?: ReleaseLifecycleFn;
  readonly publish?: ReleaseLifecycleFn;
  readonly success?: ReleaseLifecycleFn;
}

function isReleaseLifecycleFnOrUndefined(value: unknown): value is ReleaseLifecycleFn | undefined {
  return value === undefined || typeof value === 'function';
}

function isReleasePluginModule(value: unknown): value is LoadedReleasePlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if ('verifyConditions' in value && !isReleaseLifecycleFnOrUndefined(value.verifyConditions)) {
    return false;
  }
  if ('prepare' in value && !isReleaseLifecycleFnOrUndefined(value.prepare)) {
    return false;
  }
  if ('publish' in value && !isReleaseLifecycleFnOrUndefined(value.publish)) {
    return false;
  }
  if ('success' in value && !isReleaseLifecycleFnOrUndefined(value.success)) {
    return false;
  }
  return true;
}

/** Loads a publish plugin module directly (bypassing semantic-release's own step-pipeline machinery, since phase 5 cannot go through it -- see this file's own top-of-file note), caching by resolved path so a plugin shared by several packages is imported once per run rather than once per package per phase. */
async function loadReleasePlugin(absolutePath: string, cache: Map<string, LoadedReleasePlugin>): Promise<LoadedReleasePlugin> {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  const loaded: unknown = await import(pathToFileURL(absolutePath).href);
  if (!isReleasePluginModule(loaded)) {
    throw new ReleaseConfigurationError(
      `The publish plugin resolved to ${absolutePath} does not export a recognised semantic-release plugin interface (verifyConditions/prepare/publish/success functions), so commitStrategy "single" cannot call its lifecycle steps directly.`,
    );
  }
  cache.set(absolutePath, loaded);
  return loaded;
}
