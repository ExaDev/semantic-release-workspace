/**
 * The commit message format for a cross-package dependency-range bump, shared between the code that writes it (`bumpDependents` in `release.ts`) and the code that reads it back (`createScopedPlugins` in `plugins.ts`).
 *
 * The subject line alone (`chore(deps): bump @scope/a to ^1.1.0 in @scope/b [skip ci]`) is for humans reading `git log`. Recovering the forced-patch decision from a commit already sitting in history -- rather than only from the in-memory record a single run builds as it goes -- needs a machine-parseable form as well, because a run that starts after a previous run already committed and pushed the bump (whether that previous run crashed immediately afterwards, or simply finished days ago) has no in-memory record at all: the only place the fact "this dependency range changed because a sibling released" is stated is the repository itself. The trailer below is that statement.
 */

const TRAILER_DEPENDENCY = 'Bumped-Workspace-Dependency';
const TRAILER_VERSION = 'Bumped-Workspace-Dependency-Version';
const TRAILER_RANGE = 'Bumped-Workspace-Dependency-Range';

export interface DependencyBumpCommitInfo {
  readonly dependency: string;
  readonly version: string;
  readonly range: string;
}

/** Builds the full commit message (subject and trailer) for one dependency-range bump. */
export function formatDependencyBumpMessage(info: DependencyBumpCommitInfo & { readonly dependent: string }): string {
  const subject = `chore(deps): bump ${info.dependency} to ${info.range} in ${info.dependent} [skip ci]`;
  const trailer = [`${TRAILER_DEPENDENCY}: ${info.dependency}`, `${TRAILER_VERSION}: ${info.version}`, `${TRAILER_RANGE}: ${info.range}`].join('\n');
  return `${subject}\n\n${trailer}`;
}

/**
 * Recovers the dependency bump a `formatDependencyBumpMessage` commit recorded, from its full git message (subject and body), or `undefined` if the message carries no such trailer. All three lines must be present for the commit to be treated as a bump commit at all -- a message missing even one is left alone rather than partially trusted.
 */
export function parseDependencyBumpTrailer(message: string): DependencyBumpCommitInfo | undefined {
  const dependency = matchTrailerLine(message, TRAILER_DEPENDENCY);
  const version = matchTrailerLine(message, TRAILER_VERSION);
  const range = matchTrailerLine(message, TRAILER_RANGE);
  if (dependency === undefined || version === undefined || range === undefined) {
    return undefined;
  }
  return { dependency, version, range };
}

function matchTrailerLine(message: string, key: string): string | undefined {
  const prefix = `${key}: `;
  const line = message.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length).trim();
}
