import { describe, expect, it } from 'vitest';
import { MAX_BRANCH_MOVES_PER_PACKAGE, releasePackageAcrossBranchMoves, type BranchTracker } from './branch-integration';
import { WorkspaceStateError } from './errors';

/** A branch that reports a different tip on every observation, so every attempt looks like it was raced. */
function alwaysMoving(): BranchTracker {
  let counter = 0;
  const next = async (): Promise<string> => {
    counter += 1;
    return Promise.resolve(`tip-${String(counter)}`);
  };
  return { integrate: next, tip: next };
}

/** A branch that never moves: every observation reports the same tip, so "no release" is trustworthy. */
function stationary(): BranchTracker {
  return { integrate: async () => Promise.resolve('tip'), tip: async () => Promise.resolve('tip') };
}

function noRelease(): { readonly released: false; readonly version: undefined; readonly result: string } {
  return { released: false, version: undefined, result: 'no-release' };
}

describe('releasePackageAcrossBranchMoves', () => {
  it('fails with the documented error after exactly the bound when the branch never settles', async () => {
    let attempts = 0;
    const attempt = async (): Promise<ReturnType<typeof noRelease>> => {
      attempts += 1;
      return Promise.resolve(noRelease());
    };

    await expect(releasePackageAcrossBranchMoves('@fixture/b', alwaysMoving(), attempt, () => undefined)).rejects.toThrow(WorkspaceStateError);
    // Exactly the bound, not one more: the throw replaces the attempt that would have followed, rather than happening after a wasted extra release.
    expect(attempts).toBe(MAX_BRANCH_MOVES_PER_PACKAGE);
  });

  it('names the package and the count it gave up after, so a run that fails this way explains itself', async () => {
    await expect(releasePackageAcrossBranchMoves('@fixture/b', alwaysMoving(), async () => Promise.resolve(noRelease()), () => undefined)).rejects.toThrow(
      new RegExp(`@fixture/b reported no release ${String(MAX_BRANCH_MOVES_PER_PACKAGE)} times`),
    );
  });

  it('never resolves to "nothing to release" when the branch was moving, which is the silent partial release it exists to stop', async () => {
    const outcome = await releasePackageAcrossBranchMoves('@fixture/b', alwaysMoving(), async () => Promise.resolve(noRelease()), () => undefined).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(WorkspaceStateError);
  });

  it('accepts "no release" without retrying when the branch held still, since then the answer is trustworthy', async () => {
    let attempts = 0;
    const attempt = async (): Promise<ReturnType<typeof noRelease>> => {
      attempts += 1;
      return Promise.resolve(noRelease());
    };

    await expect(releasePackageAcrossBranchMoves('@fixture/b', stationary(), attempt, () => undefined)).resolves.toMatchObject({ released: false });
    expect(attempts).toBe(1);
  });

  it('stops as soon as an attempt establishes an answer, rather than retrying a package that did release', async () => {
    let attempts = 0;
    const attempt = async (): Promise<{ readonly released: boolean; readonly version: string | undefined; readonly result: string }> => {
      attempts += 1;
      // The branch is moving throughout, so without the released check this package would be released again and again until the bound.
      return Promise.resolve(attempts === 2 ? { released: true, version: '1.1.0', result: 'released' } : noRelease());
    };

    await expect(releasePackageAcrossBranchMoves('@fixture/b', alwaysMoving(), attempt, () => undefined)).resolves.toMatchObject({ released: true, version: '1.1.0' });
    expect(attempts).toBe(2);
  });
});
