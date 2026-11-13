/**
 * The trailer every release commit this package writes carries, beside the one a dependency-bump commit carries (see `dependency-bump-commit.ts`). It is how `createScopedPlugins` recognises a commit the orchestrator wrote, by a machine-readable line and never by its subject, so such a commit never counts for a package through `packageSources`: a release commit rewrites the released package's manifest and changelog, and counting it for a package whose sources cover that directory would release the package again whenever the project's analyser treats `chore` as releasable.
 *
 * The trailer is reserved for the orchestrator. A `@semantic-release/git` `message` template that replaces the default one has to end with this line, and `releaseWorkspace` refuses a configuration where it does not while `packageSources` is set.
 */
export const RELEASE_COMMIT_TRAILER = 'Workspace-Release-Commit: true';

/** The final paragraph of a commit message: the only place git's own trailer convention reads trailers from, so a line quoted earlier in a body is never mistaken for one. */
export function finalParagraph(message: string): string {
  const paragraphs = message.trim().split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1] ?? '';
}

/** Whether a commit message carries `RELEASE_COMMIT_TRAILER` on a line of its own in its final paragraph. */
export function isReleaseCommitMessage(message: string): boolean {
  return finalParagraph(message)
    .split('\n')
    .some((line) => line.trim() === RELEASE_COMMIT_TRAILER);
}
