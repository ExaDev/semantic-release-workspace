import { describe, expect, it } from 'vitest';
import { highestReleaseType, isReleaseType, raiseReleaseType } from './release-type';

describe('isReleaseType', () => {
  it('accepts every semantic-release release type and nothing else', () => {
    for (const type of ['major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease']) {
      expect(isReleaseType(type)).toBe(true);
    }
    expect(isReleaseType('enormous')).toBe(false);
    expect(isReleaseType(undefined)).toBe(false);
  });
});

describe('highestReleaseType', () => {
  it('ranks major over minor over patch, whatever order they arrive in', () => {
    expect(highestReleaseType(['patch', 'major', 'minor'])).toBe('major');
    expect(highestReleaseType(['patch', 'minor', 'patch'])).toBe('minor');
    expect(highestReleaseType(['patch'])).toBe('patch');
  });

  it('ranks the pre-release types as @semantic-release/commit-analyzer does', () => {
    expect(highestReleaseType(['minor', 'premajor'])).toBe('premajor');
    expect(highestReleaseType(['preminor', 'patch'])).toBe('preminor');
  });

  it('has no highest type among none', () => {
    expect(highestReleaseType([])).toBeUndefined();
  });
});

describe('raiseReleaseType', () => {
  it('raises the base only to a higher type', () => {
    expect(raiseReleaseType('patch', 'minor')).toBe('minor');
    expect(raiseReleaseType('minor', 'patch')).toBe('minor');
    expect(raiseReleaseType('minor', 'minor')).toBe('minor');
    expect(raiseReleaseType('minor', undefined)).toBe('minor');
  });
});
