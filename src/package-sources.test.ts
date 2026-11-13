import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError } from './errors';
import { buildDependencyGraph } from './graph';
import { isPackageSources, resolvePackageSources, toPathspecs } from './package-sources';
import type { WorkspacePackage } from './workspace';

function packageFixture(name: string): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    private: false,
    directory: `/work/packages/${name}`,
    relativeDirectory: `packages/${name}`,
    repoRelativeDirectory: `packages/${name}`,
    manifestPath: `/work/packages/${name}/package.json`,
    dependencies: new Map(),
  };
}

const graph = buildDependencyGraph([packageFixture('a'), packageFixture('b')]);

describe('resolvePackageSources', () => {
  it('gives every package an empty list when nothing is configured', () => {
    expect(resolvePackageSources(graph, undefined)).toEqual(
      new Map([
        ['a', []],
        ['b', []],
      ]),
    );
  });

  it('keeps the packages it does not name empty and normalises the ones it does', () => {
    const resolved = resolvePackageSources(graph, { a: ['rust/crates/a/', './conformance/a', 'rust//bindings/*/src', 'rust/crates/a'] });
    expect(resolved.get('a')).toEqual(['rust/crates/a', 'conformance/a', 'rust/bindings/*/src']);
    expect(resolved.get('b')).toEqual([]);
  });

  it('rejects a package that is not in the workspace', () => {
    expect(() => resolvePackageSources(graph, { missing: ['rust/crates/x'] })).toThrow(/"missing" is not a package in this workspace/);
  });

  it.each([
    ['an absolute path', '/etc/passwd', /is an absolute path/],
    ['a drive path', 'C:/work', /is an absolute path/],
    ['a path escaping the repository', '../outside', /escapes the repository/],
    ['a path escaping from the middle', 'rust/../../outside', /escapes the repository/],
    ['the repository root', '.', /names no path below the repository root/],
    ['an empty string', '', /names no path below the repository root/],
    ['a backslash path', 'rust\\crates', /contains a backslash/],
    ['a lone wildcard', '*', /is made only of `\*`, `\*\*` and `\?` segments/],
    ['a current-directory wildcard', './**', /is made only of/],
    ['a lone single-character wildcard', '?', /is made only of/],
    ['a lone double wildcard', '**', /is made only of `\*`, `\*\*` and `\?` segments/],
    ['a wildcard directory with a double wildcard', '*/**', /is made only of `\*`, `\*\*` and `\?` segments/],
    ['a double wildcard with a wildcard file', '**/*', /is made only of `\*`, `\*\*` and `\?` segments/],
    ['a single-character wildcard', '?/**', /is made only of `\*`, `\*\*` and `\?` segments/],
  ])('rejects %s', (_label, pattern, message) => {
    expect(() => resolvePackageSources(graph, { a: [pattern] })).toThrow(ReleaseConfigurationError);
    expect(() => resolvePackageSources(graph, { a: [pattern] })).toThrow(message);
  });

  it('names the package and the pattern when it refuses a pattern with no literal segment', () => {
    expect(() => resolvePackageSources(graph, { b: ['**/*'] })).toThrow(/b: "\*\*\/\*" is made only of `\*`, `\*\*` and `\?` segments/);
  });

  it.each(['rust/**', 'rust/*/src', '**/src', '*.rs', 'rust/crates/*'])('accepts %s, which names a literal segment or part of one', (pattern) => {
    expect(resolvePackageSources(graph, { a: [pattern] }).get('a')).toEqual([pattern]);
  });

  it('reports every offence at once', () => {
    expect(() => resolvePackageSources(graph, { a: ['/abs', '../up'], zzz: [] })).toThrow(/"zzz" is not a package.*a: "\/abs".*a: "\.\.\/up"|a: "\/abs".*a: "\.\.\/up".*"zzz"/);
  });
});

describe('isPackageSources', () => {
  it('accepts a map of string arrays and nothing else', () => {
    expect(isPackageSources({ a: ['x'], b: [] })).toBe(true);
    expect(isPackageSources(['x'])).toBe(false);
    expect(isPackageSources({ a: 'x' })).toBe(false);
    expect(isPackageSources({ a: [1] })).toBe(false);
    expect(isPackageSources(null)).toBe(false);
  });
});

describe('toPathspecs', () => {
  it('roots each pattern at the repository toplevel and covers everything beneath it', () => {
    expect(toPathspecs(['rust/crates/a'])).toEqual([':(top,glob)rust/crates/a', ':(top,glob)rust/crates/a/**']);
  });
});
