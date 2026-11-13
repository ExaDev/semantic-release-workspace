/**
 * The trailer every release commit this package writes carries, beside the one a dependency-bump commit carries (see `dependency-bump-commit.ts`). It is how `createScopedPlugins` recognises a commit the orchestrator wrote, by a machine-readable line and never by its subject, so such a commit never counts for a package through `packageSources`: a release commit rewrites the released package's manifest and changelog, and counting it for a package whose sources cover that directory would release the package again whenever the project's analyser treats `chore` as releasable.
 *
 * The trailer is reserved for the orchestrator. A `@semantic-release/git` message template that replaces the default one has to include it for the commit to be recognised.
 */
export const RELEASE_COMMIT_TRAILER = 'Workspace-Release-Commit: true';

/** Whether a commit message carries `RELEASE_COMMIT_TRAILER` on a line of its own. */
export function isReleaseCommitMessage(message: string): boolean {
  return message.split('\n').some((line) => line.trim() === RELEASE_COMMIT_TRAILER);
}
