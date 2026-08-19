import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitCommandError } from './errors';

const execFileAsync = promisify(execFile);

/** `git log --name-only` over everything since a package's last release tag can legitimately produce tens of megabytes of path output on a long-lived monorepo, well past execFile's default buffer, failing on exactly the big workspaces this tool exists for. */
const GIT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

/** Separates one commit's record in `git log --format` output. Chosen from the C0 control range so it can never appear in a hash or a file path. */
const COMMIT_RECORD_SEPARATOR = '\x1e';

/** The identity semantic-release's own core writes release commits under in CI when nothing else is configured (its COMMIT_NAME/COMMIT_EMAIL constants); dependency-bump commits use the same fallback so every commit a release run produces has a consistent author when the repository declares none. */
const BOT_IDENTITY = { name: 'semantic-release-bot', email: 'semantic-release-bot@martynus.net' } as const;

export interface GitCommandOptions {
  readonly cwd: string;
}

export async function git(args: readonly string[], options: GitCommandOptions): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd: options.cwd, maxBuffer: GIT_MAX_BUFFER_BYTES });
    return stdout;
  } catch (cause) {
    throw toGitCommandError(args, options.cwd, cause);
  }
}

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Maps every commit in `from..HEAD` (or the whole history when `from` is undefined) to the set of paths it changed, by running `git log --name-only` once per package release -- the same diff-and-filter technique the design calls for, so a commit counts for a package only when a path under that package's directory appears in its file list.
 *
 * Merge commits list no files (git shows no diff for them without `--diff-merges`), so they count for no package; their changes arrive through their parents, which the same range covers individually. Squash-merge workflows are unaffected, since a squash commit is an ordinary commit with a full file list.
 */
export async function changedPathsSince(from: string | undefined, options: GitCommandOptions): Promise<Map<string, ReadonlySet<string>>> {
  const range = from === undefined ? 'HEAD' : `${from}..HEAD`;
  const output = await git(['log', '--name-only', '--no-renames', `--format=${COMMIT_RECORD_SEPARATOR}%H`, range], options);
  return parseChangedPaths(output);
}

export function parseChangedPaths(output: string): Map<string, ReadonlySet<string>> {
  const changedPaths = new Map<string, ReadonlySet<string>>();
  for (const record of output.split(COMMIT_RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (trimmed === '') {
      continue;
    }
    const lines = trimmed.split('\n');
    const hash = lines[0];
    if (hash === undefined || hash === '') {
      continue;
    }
    changedPaths.set(hash, new Set(lines.slice(1).filter((line) => line !== '')));
  }
  return changedPaths;
}

/** The branch a dependency-bump commit will be pushed to. Refuses a detached HEAD by name rather than pushing `HEAD:HEAD` to the remote and watching it fail somewhere less legible. */
export async function currentBranch(options: GitCommandOptions): Promise<string> {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], options)).trim();
  if (branch === 'HEAD') {
    throw new GitCommandError(['rev-parse', '--abbrev-ref', 'HEAD'], options.cwd, undefined, 'HEAD is detached; there is no branch name to push dependency-bump commits to. Run the release from a branch checkout.');
  }
  return branch;
}

/** The commit identity for dependency-bump commits: whatever the repository itself configures, and semantic-release's own bot identity when nothing is (a release run's commits must name an author even on a bare CI runner). */
export async function resolveCommitIdentity(options: GitCommandOptions): Promise<CommitIdentity> {
  const name = await readConfig('user.name', options);
  const email = await readConfig('user.email', options);
  if (name === undefined || email === undefined) {
    return BOT_IDENTITY;
  }
  return { name, email };
}

/** `git config` exits 1 when a key is simply unset -- that is an expected answer here, not a failure; any other exit code (128 for "not a repository", and so on) propagates. */
async function readConfig(key: 'user.name' | 'user.email', options: GitCommandOptions): Promise<string | undefined> {
  try {
    const value = (await git(['config', key], options)).trim();
    return value === '' ? undefined : value;
  } catch (cause) {
    if (cause instanceof GitCommandError && cause.exitCode === 1) {
      return undefined;
    }
    throw cause;
  }
}

/** Commits exactly the given paths (already written to disk) with an explicit identity, so the bump commit does not depend on whatever ambient git configuration the CI runner happens to have. */
export async function commitFiles(files: readonly string[], message: string, options: GitCommandOptions & { readonly identity: CommitIdentity }): Promise<void> {
  await git(['add', '--', ...files], options);
  await git(
    ['-c', `user.name=${options.identity.name}`, '-c', `user.email=${options.identity.email}`, 'commit', '-m', message, '--', ...files],
    options,
  );
}

/** Pushes the current branch's head to origin by explicit refspec. Each dependency bump is pushed the moment it is committed -- the same discipline semantic-release applies to its own release commits -- so an interrupted run never leaves local commits that exist nowhere else. */
export async function pushHead(options: GitCommandOptions): Promise<void> {
  const branch = await currentBranch(options);
  await git(['push', 'origin', `HEAD:${branch}`], options);
}

function toGitCommandError(args: readonly string[], cwd: string, cause: unknown): GitCommandError {
  const exitCode = cause instanceof Error && 'code' in cause && typeof cause.code === 'number' ? cause.code : undefined;
  const stderr = cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string' ? cause.stderr.trim() : '';
  const detail = stderr !== '' ? stderr : cause instanceof Error ? cause.message : String(cause);
  return new GitCommandError(args, cwd, exitCode, detail);
}
