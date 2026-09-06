import { describe, expect, it } from 'vitest';
import { GitCommandError, WorkspaceStateError } from './errors';
import { changedPathsSince, createTag, currentBranch, git, pushHead, pushHeadAndTags, resolveCommitIdentity } from './git';
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

describe('pushHeadAndTags', () => {
  it('leaves no tag on the remote when the branch update it must land with is rejected as a non-fast-forward', async () => {
    const fixture = await createWorkspaceFixture(onePackage, []);
    try {
      // A second clone races this one: it commits and pushes to origin/main first, so this fixture's own upcoming `HEAD:main` push is a stale, non-fast-forward update -- exactly what happens when an ordinary PR merges to main while a `commitStrategy: 'single'` release run is still between its own local commit and its final push.
      const race = await createWorkspaceFixture(onePackage, []);
      await git(['remote', 'set-url', 'origin', (await git(['remote', 'get-url', 'origin'], { cwd: fixture.root })).trim()], { cwd: race.root });
      await git(['fetch', 'origin'], { cwd: race.root });
      await git(['reset', '--hard', 'origin/main'], { cwd: race.root });
      await git(['commit', '--allow-empty', '-m', 'feat: a concurrent, unrelated merge to main'], { cwd: race.root });
      await git(['push', 'origin', 'HEAD:main'], { cwd: race.root });
      await race.remove();

      // This fixture's own local commit and tag are now built on a main that origin has already moved past.
      await git(['commit', '--allow-empty', '-m', 'chore(release): batch release [skip ci]'], { cwd: fixture.root });
      const staleSha = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      await createTag('@fixture/only@1.1.0', staleSha, { cwd: fixture.root });

      await expect(pushHeadAndTags(['@fixture/only@1.1.0'], { cwd: fixture.root })).rejects.toBeInstanceOf(GitCommandError);

      // The whole point: a rejected branch update must take the tag down with it. Landing the tag anyway would leave a permanently orphaned ref -- nothing points at it from main, yet its name is now taken forever, so every future run that (correctly, deterministically) recomputes the same next version for this package fails re-creating the same tag, on every single run, with no way to self-heal.
      const remoteTags = await git(['ls-remote', '--tags', 'origin'], { cwd: fixture.root });
      expect(remoteTags).not.toContain('@fixture/only@1.1.0');
    } finally {
      await fixture.remove();
    }
    // 20s, not the file's default: two full workspace fixtures (each its own git init, bare remote, and initial push) run here, tight against the default budget under the disk and process contention a full concurrent suite run adds.
  }, 20_000);
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
