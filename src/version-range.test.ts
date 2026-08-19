import { describe, expect, it } from 'vitest';
import { UnsupportedDependencyRangeError } from './errors';
import { classifyDependencyRange, updateDependencyRange } from './version-range';

describe('updateDependencyRange', () => {
  it('rewrites the version in a single caret comparator, preserving the comparator', () => {
    expect(updateDependencyRange('^1.0.0', '1.2.3')).toEqual({ kind: 'rewritten', range: '^1.2.3' });
  });

  it('rewrites tilde, >=, and bare equality comparators', () => {
    expect(updateDependencyRange('~1.0.0', '2.0.0')).toEqual({ kind: 'rewritten', range: '~2.0.0' });
    expect(updateDependencyRange('>=1.0.0', '2.0.0')).toEqual({ kind: 'rewritten', range: '>=2.0.0' });
    expect(updateDependencyRange('=1.0.0', '1.0.1')).toEqual({ kind: 'rewritten', range: '=1.0.1' });
    expect(updateDependencyRange('1.0.0', '1.0.1')).toEqual({ kind: 'rewritten', range: '1.0.1' });
  });

  it('rewrites the concrete version inside a workspace: range', () => {
    expect(updateDependencyRange('workspace:^1.0.0', '1.1.0')).toEqual({ kind: 'rewritten', range: 'workspace:^1.1.0' });
  });

  it('treats publish-resolved workspace wildcards as needing no manifest edit but still a dependent release', () => {
    expect(updateDependencyRange('workspace:*', '1.1.0')).toEqual({ kind: 'resolved-at-publish' });
    expect(updateDependencyRange('workspace:^', '1.1.0')).toEqual({ kind: 'resolved-at-publish' });
    expect(updateDependencyRange('workspace:~', '1.1.0')).toEqual({ kind: 'resolved-at-publish' });
  });

  it('treats wildcard ranges as unaffected by the sibling version', () => {
    expect(updateDependencyRange('*', '1.0.0')).toEqual({ kind: 'wildcard' });
    expect(updateDependencyRange('x', '1.0.0')).toEqual({ kind: 'wildcard' });
    expect(updateDependencyRange('latest', '1.0.0')).toEqual({ kind: 'wildcard' });
  });

  it('rejects upper bounds rather than narrowing them onto the released version', () => {
    expect(() => updateDependencyRange('<2.0.0', '1.4.0')).toThrow(UnsupportedDependencyRangeError);
    expect(() => updateDependencyRange('<=2.0.0', '1.4.0')).toThrow(UnsupportedDependencyRangeError);
  });

  it('rejects ranges whose shape cannot be rewritten in place without changing their meaning', () => {
    expect(() => updateDependencyRange('>=1.0.0 <2.0.0', '1.4.0')).toThrow(UnsupportedDependencyRangeError);
    expect(() => updateDependencyRange('1.x || 2.x', '1.4.0')).toThrow(UnsupportedDependencyRangeError);
    expect(() => updateDependencyRange('catalog:', '1.4.0')).toThrow(/catalog:/);
    expect(() => updateDependencyRange('npm:other-package@^1.0.0', '1.4.0')).toThrow(/alias/);
    expect(() => updateDependencyRange('git+https://example.com/repo.git', '1.4.0')).toThrow(UnsupportedDependencyRangeError);
  });

  it('ignores surrounding whitespace', () => {
    expect(updateDependencyRange('  ^1.0.0  ', '1.2.3')).toEqual({ kind: 'rewritten', range: '^1.2.3' });
  });
});

describe('classifyDependencyRange', () => {
  it('classifies a rewritable range without needing any released version', () => {
    expect(classifyDependencyRange('^1.0.0')).toEqual({ kind: 'rewritable', workspacePrefixed: false, comparator: '^' });
    expect(classifyDependencyRange('workspace:~1.0.0')).toEqual({ kind: 'rewritable', workspacePrefixed: true, comparator: '~' });
  });

  it('classifies publish-resolved and wildcard shapes', () => {
    expect(classifyDependencyRange('workspace:^')).toEqual({ kind: 'resolved-at-publish' });
    expect(classifyDependencyRange('*')).toEqual({ kind: 'wildcard' });
  });

  it('throws for every shape updateDependencyRange also rejects, independent of any version', () => {
    expect(() => classifyDependencyRange('>=1.0.0 <2.0.0')).toThrow(UnsupportedDependencyRangeError);
    expect(() => classifyDependencyRange('catalog:')).toThrow(/catalog:/);
    expect(() => classifyDependencyRange('npm:other-package@^1.0.0')).toThrow(/alias/);
  });
});
