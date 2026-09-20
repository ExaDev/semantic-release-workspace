import { WorkspaceStateError } from './errors';
import { packageName } from './package-name';

/**
 * How many times one package may be released again after the branch moved underneath its own attempt, before the run gives up loudly.
 *
 * There is no option for this and no derivation from a measured rate, unlike `pushAttempts`. Integration happens at most once per package boundary, so the loop is already bounded by the size of the workspace; this only bounds the pathological case where the branch moves during the same package's attempt over and over. Each round costs one package's analysis, and the branch would have to move during three consecutive attempts at the same package to exhaust it, at which point the run is being starved rather than raced, and saying so is more useful than trying again.
 */
export const MAX_BRANCH_MOVES_PER_PACKAGE = 3;

/**
 * The release branch, as this loop needs to see it: somewhere it can advance the checkout to, and somewhere it can ask where the branch is now.
 *
 * A port rather than direct git calls, so the bound below can be exercised by a test that decides what the branch does. Driving that from a real repository would need a competing pusher on a timer, since the case only arises when the branch moves *during* a package's own attempt, and a timing-dependent test of a release pipeline's last line of defence is worth less than no test at all.
 */
export interface BranchTracker {
  /** Brings the checkout up to the branch's current tip, and reports that tip. */
  readonly integrate: () => Promise<string>;
  /** Reports the branch's current tip without changing the checkout. */
  readonly tip: () => Promise<string>;
}

/** What one attempt at releasing a package reports back: whether it released, at what version, and the caller's own opaque result. */
export interface PackageReleaseAttempt<TResult> {
  readonly released: boolean;
  readonly version: string | undefined;
  readonly result: TResult;
}

/**
 * Releases one package, integrating the release branch first and again whenever it moves under the attempt.
 *
 * This exists because semantic-release cannot tell the orchestrator apart the two reasons it declines to release. When the branch has moved since the run began, its `verifyAuth` fails, `isBranchUpToDate` reports the branch behind, and it returns the same "no release" the orchestrator gets for a package that genuinely had nothing to publish. Taking that at face value is how a run used to finish green having released only the packages that happened to come before the branch moved.
 *
 * The ambiguity is resolved by observation rather than by reading semantic-release's logs: if the branch did not move while the package was being released, "no release" is true. If it did, the answer is not trustworthy, so the branch is integrated and the package is released again against the new tip. That is safe to repeat because a package that really has nothing to release still has nothing after a fast-forward, and a package that does release is recorded by its tag, which every later run reads as the release having happened.
 *
 * A package whose answer is never established fails the run. Returning "nothing to release" for it would be a guess, and the guess that loses is exactly the silent partial release this loop exists to stop.
 */
export async function releasePackageAcrossBranchMoves<TResult>(
  name: string,
  branch: BranchTracker,
  attempt: () => Promise<PackageReleaseAttempt<TResult>>,
  log: (message: string) => void,
): Promise<PackageReleaseAttempt<TResult>> {
  for (let moves = 1; ; moves += 1) {
    const tipBefore = await branch.integrate();
    const outcome = await attempt();
    if (outcome.released) {
      return outcome;
    }
    const tipAfter = await branch.tip();
    if (tipAfter === tipBefore) {
      return outcome;
    }
    if (moves >= MAX_BRANCH_MOVES_PER_PACKAGE) {
      throw new WorkspaceStateError(
        `${packageName}: ${name} reported no release ${String(moves)} times, each time while the release branch was moving underneath it, so whether it had anything to release was never established. Failing rather than finishing the run as though it had nothing, which would leave this package and every one after it silently unreleased. Re-running once the branch is quieter is safe: packages that already released are recorded by their tags and are not released again.`,
      );
    }
    log(`${name}: reported no release while the branch moved from ${tipBefore} to ${tipAfter}, which is also what a stale branch looks like; integrating and releasing it again.`);
  }
}
