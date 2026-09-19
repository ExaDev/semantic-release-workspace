import { describe, expect, it } from 'vitest';
import { DEFAULT_TAG_FORMAT, formatTagForPackage, validateTagFormat } from './tag-format';

describe('validateTagFormat', () => {
  it('accepts the default template', () => {
    expect(validateTagFormat(DEFAULT_TAG_FORMAT)).toBe('${name}@${version}');
  });

  it('accepts a template with only the version placeholder', () => {
    expect(validateTagFormat('v${version}')).toBe('v${version}');
  });

  it('rejects a template without the version placeholder', () => {
    expect(() => validateTagFormat('${name}')).toThrow(/must contain '\$\{version\}'/);
  });

  it('rejects unknown placeholder tokens as typos rather than releasing them literally into tags', () => {
    // A typo'd placeholder also removes the only valid version token, so the version check fires first: still a loud failure, still before anything releases.
    expect(() => validateTagFormat('${name}-v${verison}')).toThrow(/must contain '\$\{version\}'/);
    expect(() => validateTagFormat('${scope}/${name}@${version}')).toThrow(/unknown token/i);
  });
});

describe('formatTagForPackage', () => {
  it('substitutes the package name and leaves the version placeholder for semantic-release', () => {
    expect(formatTagForPackage(DEFAULT_TAG_FORMAT, 'setup-texlive')).toBe('setup-texlive@${version}');
    expect(formatTagForPackage('${name}-v${version}', 'setup-texlive')).toBe('setup-texlive-v${version}');
  });

  it('leaves a template without the name placeholder untouched', () => {
    expect(formatTagForPackage('v${version}', 'setup-texlive')).toBe('v${version}');
  });
});
