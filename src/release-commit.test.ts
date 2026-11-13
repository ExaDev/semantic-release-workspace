import { describe, expect, it } from 'vitest';
import { RELEASE_COMMIT_TRAILER, isReleaseCommitMessage } from './release-commit';

describe('isReleaseCommitMessage', () => {
  it('recognises the trailer in the final paragraph', () => {
    expect(isReleaseCommitMessage(`chore(release): a@1.0.1 [skip ci]\n\n${RELEASE_COMMIT_TRAILER}`)).toBe(true);
    expect(isReleaseCommitMessage(`chore(release): batch release [skip ci]\n\n- a@1.0.1 (patch)\n\n${RELEASE_COMMIT_TRAILER}\n`)).toBe(true);
  });

  it('ignores the line quoted anywhere but the final paragraph', () => {
    expect(isReleaseCommitMessage(`feat(a): quote it\n\n${RELEASE_COMMIT_TRAILER}\n\nMore text after.`)).toBe(false);
    expect(isReleaseCommitMessage(`${RELEASE_COMMIT_TRAILER}\n\nfeat(a): subject last`)).toBe(false);
  });

  it('ignores a message without the line', () => {
    expect(isReleaseCommitMessage('chore(release): a@1.0.1 [skip ci]')).toBe(false);
  });
});
