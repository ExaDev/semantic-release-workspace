import { describe, expect, it } from 'vitest';
import { resolveBundledDependencies } from './bundling';
import { ReleaseConfigurationError } from './errors';
import { buildDependencyGraph, type DependencyGraph } from './graph';
import { type DependencyField } from './manifest';
import type { WorkspacePackage } from './workspace';

function packageFixture(name: string, options: { readonly private?: boolean; readonly fields?: Partial<Record<DependencyField, Readonly<Record<string, string>>>> } = {}): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    private: options.private ?? false,
    directory: `/work/packages/${name}`,
    relativeDirectory: `packages/${name}`,
    repoRelativeDirectory: `packages/${name}`,
    manifestPath: `/work/packages/${name}/package.json`,
    dependencies: new Map(Object.entries(options.fields ?? {}).map(([field, declared]) => [toField(field), new Map(Object.entries(declared))])),
  };
}

function toField(field: string): DependencyField {
  if (field === 'dependencies' || field === 'devDependencies' || field === 'peerDependencies' || field === 'optionalDependencies') {
    return field;
  }
  throw new Error(`Not a dependency field: ${field}`);
}

/** A public `app` that bundles the private `core` and `mid` (each in its devDependencies), where `mid` itself depends at run time on the private `deep`, and also installs the public `lib` and lists the public `lint` as a tool. */
function bundlingWorkspace(): DependencyGraph {
  return buildDependencyGraph([
    packageFixture('core', { private: true }),
    packageFixture('deep', { private: true }),
    packageFixture('mid', { private: true, fields: { dependencies: { deep: 'workspace:*' } } }),
    packageFixture('lib'),
    packageFixture('lint'),
    packageFixture('app', { fields: { dependencies: { lib: '^1.0.0' }, devDependencies: { core: '1.0.0', mid: '1.0.0', lint: '1.0.0' } } }),
  ]);
}

describe('resolveBundledDependencies', () => {
  it('takes the release type of every workspace devDependency of a named bundling package, and of no ordinary dependency', () => {
    const app = resolveBundledDependencies(bundlingWorkspace(), ['app']).get('app');
    expect(app?.releaseTypeFrom).toEqual(new Set(['core', 'mid', 'lint']));
    expect(app?.carried).toEqual(new Set(['core', 'mid', 'lint']));
  });

  it('lets a private package carry its private run-time dependencies, without taking their release type itself', () => {
    const mid = resolveBundledDependencies(bundlingWorkspace(), ['app']).get('mid');
    expect(mid?.releaseTypeFrom).toEqual(new Set());
    expect(mid?.carried).toEqual(new Set(['deep']));
  });

  it('changes no package release type when no package is named', () => {
    for (const bundled of resolveBundledDependencies(bundlingWorkspace(), undefined).values()) {
      expect(bundled.releaseTypeFrom).toEqual(new Set());
    }
  });

  it('carries nothing through a private package devDependency or a public run-time dependency', () => {
    const graph = buildDependencyGraph([
      packageFixture('tooling', { private: true }),
      packageFixture('lib'),
      packageFixture('internal', { private: true, fields: { dependencies: { lib: '^1.0.0' }, devDependencies: { tooling: 'workspace:*' } } }),
    ]);
    expect(resolveBundledDependencies(graph, undefined).get('internal')?.carried).toEqual(new Set());
  });

  it('rejects a name that is not a package in the workspace', () => {
    const call = (): unknown => resolveBundledDependencies(bundlingWorkspace(), ['ap']);
    expect(call).toThrow(ReleaseConfigurationError);
    expect(call).toThrow(/bundlingPackages names "ap", which is not a package in this workspace/);
  });

  it('rejects a private package, which never publishes what it bundles', () => {
    const call = (): unknown => resolveBundledDependencies(bundlingWorkspace(), ['mid']);
    expect(call).toThrow(ReleaseConfigurationError);
    expect(call).toThrow(/bundlingPackages names "mid", which is private/);
  });
});
