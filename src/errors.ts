/**
 * Every failure this package raises deliberately is one of these, so a caller (or the CLI) can tell an orchestration failure it should report cleanly apart from an unexpected crash it should let propagate with a stack trace.
 *
 * All of them are thrown, never returned as a status: the orchestrator deliberately has no "skip this package and carry on" path. A workspace that can't be discovered, ordered, or bumped correctly would otherwise publish a partially-consistent set of packages, which is strictly worse than publishing nothing.
 */
export class WorkspaceReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The workspace itself could not be read: no `pnpm-workspace.yaml`, no `packages` globs, an unreadable or malformed `package.json`, two packages claiming the same name, or a package sitting at the workspace root (which cannot be path-scoped -- see `discoverWorkspace`). */
export class WorkspaceDiscoveryError extends WorkspaceReleaseError {}

/** The intra-workspace dependency graph contains a cycle, so no release order exists in which every package releases after its own dependencies. */
export class DependencyCycleError extends WorkspaceReleaseError {
  /** The packages forming the cycle, in dependency order, with the first package repeated at the end so the loop reads end to end. */
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`Cannot compute a release order: the workspace dependency graph contains a cycle: ${cycle.join(' -> ')}`);
    this.cycle = cycle;
  }
}

/** A dependency range this tool cannot release correctly: either a range on a workspace sibling that it cannot rewrite with confidence (rewriting it wrongly, or leaving it silently stale, produces a published manifest that disagrees with the repository), or a `workspace:`, `catalog:`, `link:`, or `file:` specifier in a publishable package's published dependencies, which `npm publish` ships verbatim and no consumer can install. The run stops instead. */
export class UnsupportedDependencyRangeError extends WorkspaceReleaseError {}

/** The semantic-release options handed to the orchestrator cannot be scoped to a single package -- typically a publish plugin list that would leave a release commit or a cross-package manifest bump uncommitted. */
export class ReleaseConfigurationError extends WorkspaceReleaseError {}

/** A git command the orchestrator runs itself (history filtering, dependency-bump commits, pushes) failed. Carries the exit code so callers can distinguish "configuration is missing" (exit 1) from real repository failures. */
export class GitCommandError extends WorkspaceReleaseError {
  readonly exitCode: number | undefined;

  constructor(args: readonly string[], cwd: string, exitCode: number | undefined, detail: string) {
    super(`git ${args.join(' ')} failed in ${cwd}${exitCode === undefined ? '' : ` (exit ${String(exitCode)})`}: ${detail}`);
    this.exitCode = exitCode;
  }
}

/** The workspace's git state does not support the release operation -- for example a detached HEAD, which names no branch that dependency-bump commits could be pushed to. */
export class WorkspaceStateError extends WorkspaceReleaseError {}

/** A pnpm command this package runs itself failed: `pnpm install --lockfile-only` while regenerating the lockfile for a dependency-range bump (left unhandled, a dependent's manifest would be committed with `pnpm-lock.yaml` still naming the old range, the exact drift that step exists to prevent, so the bump aborts instead), or the install that prepares a tagged commit's checkout for republishing. */
export class PnpmCommandError extends WorkspaceReleaseError {
  constructor(args: readonly string[], cwd: string, detail: string) {
    super(`pnpm ${args.join(' ')} failed in ${cwd}: ${detail}`);
  }
}

/** A registry lookup this package makes itself (whether a released version is already published) failed for a reason other than the version being absent, so whether the release still needs publishing is unknown. */
export class RegistryQueryError extends WorkspaceReleaseError {}

/** One tagged release a recovery pass could not publish, with the reason. */
export interface UnrecoveredRelease {
  readonly name: string;
  readonly gitTag: string;
  readonly reason: string;
}

/**
 * At least one release tag whose version is missing from its registry could not be published. `failed` lists the releases whose publish failed, `blocked` the releases that were not attempted because a workspace package they depend on is in `failed`, and `recovered` the releases this pass did publish before stopping. Nothing new is released after this error, so the next run retries the same recovery first.
 */
export class UnpublishedReleaseRecoveryError extends WorkspaceReleaseError {
  readonly failed: readonly UnrecoveredRelease[];
  readonly blocked: readonly UnrecoveredRelease[];
  readonly recovered: readonly { readonly name: string; readonly version: string; readonly gitTag: string }[];

  constructor(failed: readonly UnrecoveredRelease[], blocked: readonly UnrecoveredRelease[], recovered: UnpublishedReleaseRecoveryError['recovered']) {
    const lines = [...failed.map((release) => `- ${release.gitTag}: ${release.reason}`), ...blocked.map((release) => `- ${release.gitTag}: ${release.reason}`)];
    super(
      `${String(failed.length)} release tag(s) whose version is missing from the registry could not be published, so nothing new was released and the next run retries them first:\n${lines.join('\n')}`,
    );
    this.failed = failed;
    this.blocked = blocked;
    this.recovered = recovered;
  }
}
