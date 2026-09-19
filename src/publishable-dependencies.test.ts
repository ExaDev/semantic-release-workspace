import { describe, expect, it } from 'vitest';
import { UnsupportedDependencyRangeError } from './errors';
import { DEPENDENCY_FIELDS, type DependencyField } from './manifest';
import { assertPublishableDependencies } from './publishable-dependencies';

function manifest(name: string, declared: Partial<Record<DependencyField, Readonly<Record<string, string>>>>, options: { readonly private?: boolean } = {}) {
  const dependencies = new Map<DependencyField, ReadonlyMap<string, string>>();
  for (const field of DEPENDENCY_FIELDS) {
    const ranges = declared[field];
    if (ranges !== undefined) {
      dependencies.set(field, new Map(Object.entries(ranges)));
    }
  }
  return { name, private: options.private ?? false, dependencies };
}

describe('assertPublishableDependencies', () => {
  it.each(['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.0.0', 'workspace:1.2.3', 'catalog:', 'catalog:default', 'link:../sibling', 'file:../sibling'])(
    'rejects %s in the dependencies of a publishable package, naming the package, the dependency, and the specifier',
    (specifier) => {
      const failure = () => { assertPublishableDependencies([manifest('@scope/app', { dependencies: { '@scope/lib': specifier } })]); };

      expect(failure).toThrow(UnsupportedDependencyRangeError);
      expect(failure).toThrow(/@scope\/app/);
      expect(failure).toThrow(/@scope\/lib/);
      expect(failure).toThrow(`"${specifier}"`);
    },
  );

  it.each(['peerDependencies', 'optionalDependencies'] as const)('rejects an unresolved specifier in %s', (field) => {
    expect(() => { assertPublishableDependencies([manifest('@scope/app', { [field]: { '@scope/lib': 'workspace:^' } })]); }).toThrow(UnsupportedDependencyRangeError);
  });

  it('rejects a catalog: specifier on a dependency that is not a workspace sibling', () => {
    expect(() => { assertPublishableDependencies([manifest('@scope/app', { dependencies: { zod: 'catalog:' } })]); }).toThrow(/"zod"/);
  });

  it('tells the user to declare a plain version range and to keep linkWorkspacePackages on', () => {
    expect(() => { assertPublishableDependencies([manifest('@scope/app', { dependencies: { '@scope/lib': 'workspace:^' } })]); }).toThrow(
      /Declare a plain version range instead \(for example "\^1\.2\.3"\).*linkWorkspacePackages: true/s,
    );
  });

  it('reports every offending dependency in one error rather than stopping at the first', () => {
    const failure = () => { assertPublishableDependencies([
        manifest('@scope/one', { dependencies: { '@scope/lib': 'workspace:^' }, optionalDependencies: { '@scope/extra': 'file:../extra' } }),
        manifest('@scope/two', { peerDependencies: { '@scope/lib': 'workspace:*' } }),
      ]); };

    expect(failure).toThrow(/@scope\/one.*@scope\/lib.*workspace:\^/s);
    expect(failure).toThrow(/@scope\/one.*@scope\/extra.*file:\.\.\/extra/s);
    expect(failure).toThrow(/@scope\/two.*@scope\/lib.*workspace:\*/s);
  });

  it('accepts unresolved specifiers in devDependencies, which no consumer installs', () => {
    expect(() => { assertPublishableDependencies([manifest('@scope/app', { devDependencies: { '@scope/lib': 'workspace:*' } })]); }).not.toThrow();
  });

  it('accepts every specifier in a private package, which is never published', () => {
    expect(() => { assertPublishableDependencies([
        manifest('@scope/app', { dependencies: { '@scope/lib': 'workspace:^', zod: 'catalog:' }, peerDependencies: { other: 'link:../other' } }, { private: true }),
      ]); },
    ).not.toThrow();
  });

  it('accepts concrete ranges, wildcards, and npm: aliases, which npm ships verbatim and consumers can install', () => {
    expect(() => { assertPublishableDependencies([
        manifest('@scope/app', { dependencies: { '@scope/lib': '^1.2.3', pinned: '1.0.0', anything: '*', aliased: 'npm:other@^2.0.0' } }),
      ]); },
    ).not.toThrow();
  });
});
