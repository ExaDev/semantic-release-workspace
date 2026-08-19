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

/** A dependency on a workspace sibling uses a range this tool cannot rewrite with confidence. Rewriting it wrongly, or leaving it silently stale, both produce a published manifest that disagrees with the repository, so the run stops instead. */
export class UnsupportedDependencyRangeError extends WorkspaceReleaseError {}

/** The semantic-release options handed to the orchestrator cannot be scoped to a single package -- typically a publish plugin list that would leave a release commit or a cross-package manifest bump uncommitted. */
export class ReleaseConfigurationError extends WorkspaceReleaseError {}

/** A git command the orchestrator runs itself (history filtering, dependency-bump commits, pushes) failed. Carries the exit code so callers can distinguish "configuration is missing" (exit 1) from real repository failures. */
export class GitCommandError extends WorkspaceReleaseError {
  readonly exitCode: number | undefined;

  constructor(args: readonly string[], cwd: string, exitCode: number | undefined, detail: string) {
    super(`git ${args.join(' ')} failed in ${cwd}${exitCode === undefined ? '' : ` (exit ${exitCode})`}: ${detail}`);
    this.exitCode = exitCode;
  }
}

/** The workspace's git state does not support the release operation -- for example a detached HEAD, which names no branch that dependency-bump commits could be pushed to. */
export class WorkspaceStateError extends WorkspaceReleaseError {}
