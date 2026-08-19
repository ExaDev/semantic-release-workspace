import { describe, expect, it } from 'vitest';
import { GitCommandError, WorkspaceStateError } from './errors';
import { changedPathsSince, currentBranch, git, pushHead, resolveCommitIdentity } from './git';
import { createWorkspaceFixture } from './git-workspace-fixture';

/** One package is enough for every git-level behaviour here: these tests are about the repository, not about the workspace's shape. */
const onePackage = [{ name: '@fixture/only', version: '1.0.0' }] as const;

describe('currentBranch', () => {
  it('reports the checked-out branch', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      await expect(currentBranch({ cwd: fixture.root })).resolves.toBe('main');
    } finally {
      await fixture.remove();
    }
  });

  it('rejects a detached HEAD as a workspace-state failure, not a git command failure', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      await git(['checkout', '--detach', 'HEAD'], { cwd: fixture.root });

      const failure = currentBranch({ cwd: fixture.root });
      // The distinction is the point: `git rev-parse` succeeded, so reporting this as a GitCommandError would describe a working command as a broken one.
      await expect(failure).rejects.toBeInstanceOf(WorkspaceStateError);
      await expect(failure).rejects.not.toBeInstanceOf(GitCommandError);
      await expect(failure).rejects.toThrow(/HEAD is detached/);
    } finally {
      await fixture.remove();
    }
  });
});

describe('pushHead', () => {
  it('refuses to push from a detached HEAD instead of pushing HEAD:HEAD to the remote', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      await git(['checkout', '--detach', 'HEAD'], { cwd: fixture.root });
      await expect(pushHead({ cwd: fixture.root })).rejects.toBeInstanceOf(WorkspaceStateError);
    } finally {
      await fixture.remove();
    }
  });
});

describe('resolveCommitIdentity', () => {
  it('uses the identity the repository itself configures', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      // The fixture sets these in the repository's own config, so the result does not depend on whatever global identity the host machine has.
      await expect(resolveCommitIdentity({ cwd: fixture.root })).resolves.toEqual({
        name: 'Fixture Release Bot',
        email: 'fixture@example.com',
      });
    } finally {
      await fixture.remove();
    }
  });
});

describe('changedPathsSince', () => {
  it('reports a path containing a non-ASCII character verbatim, not git-C-quoted', async () => {
    const fixture = await createWorkspaceFixture(
      [{ name: '@fixture/cafe', version: '1.0.0', directory: 'café' }],
      [{ message: 'feat(cafe): second feature', files: { 'packages/café/src/index.js': 'export const cafe = 2;\n' } }],
    );
    try {
      const paths = await changedPathsSince(undefined, { cwd: fixture.root });
      const everyPath = new Set([...paths.values()].flatMap((set) => [...set]));
      // Without core.quotePath=false, git would report this as the C-escaped `"packages/caf\303\251/src/index.js"`, which no plain-text directory prefix would ever match.
      expect(everyPath).toContain('packages/café/src/index.js');
    } finally {
      await fixture.remove();
    }
  });
});

describe('git', () => {
  it('raises a GitCommandError carrying the exit code when a command genuinely fails', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      const failure = git(['rev-parse', '--verify', 'refs/tags/@fixture/only@9.9.9'], { cwd: fixture.root });
      await expect(failure).rejects.toBeInstanceOf(GitCommandError);
      await expect(failure).rejects.toMatchObject({ exitCode: 128 });
    } finally {
      await fixture.remove();
    }
  });
});
