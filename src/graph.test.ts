import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, topologicalOrder } from './graph';
import { DependencyCycleError } from './errors';
import type { WorkspacePackage } from './workspace';

function packageFixture(name: string, dependencies: Readonly<Record<string, string>> = {}): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    directory: `/work/packages/${name}`,
    relativeDirectory: `packages/${name}`,
    manifestPath: `/work/packages/${name}/package.json`,
    dependencies: new Map([['dependencies', new Map(Object.entries(dependencies))]]),
  };
}

describe('topologicalOrder', () => {
  it('places every dependency before its dependents', () => {
    const order = topologicalOrder(
      buildDependencyGraph([packageFixture('a'), packageFixture('b', { a: '^1.0.0' }), packageFixture('c', { b: '^1.0.0' })]),
    );
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('orders a diamond with the shared base first and the join last', () => {
    const order = topologicalOrder(
      buildDependencyGraph([
        packageFixture('a'),
        packageFixture('b', { a: '^1.0.0' }),
        packageFixture('c', { a: '^1.0.0' }),
        packageFixture('d', { b: '^1.0.0', c: '^1.0.0' }),
      ]),
    );
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps unrelated packages in a deterministic (name-sorted within each layer) order', () => {
    expect(topologicalOrder(buildDependencyGraph([packageFixture('z'), packageFixture('m', { z: '^1.0.0' }), packageFixture('q')]))).toEqual([
      'q',
      'z',
      'm',
    ]);
  });

  it('ignores dependencies on packages outside the workspace', () => {
    const graph = buildDependencyGraph([packageFixture('a'), packageFixture('b', { a: '^1.0.0', react: '^19.0.0' })]);
    expect(topologicalOrder(graph)).toEqual(['a', 'b']);
    expect(graph.dependents.get('a')).toHaveLength(1);
    expect(graph.dependents.has('react')).toBe(false);
  });

  it('fails loudly on a two-package cycle, naming the loop', () => {
    const call = () => topologicalOrder(buildDependencyGraph([packageFixture('x', { y: '^1.0.0' }), packageFixture('y', { x: '^1.0.0' })]));
    expect(call).toThrow(DependencyCycleError);
    expect(call).toThrow(/@?x -> @?y -> @?x|@?y -> @?x -> @?y/);
  });

  it('fails loudly on a self-dependency', () => {
    expect(() => topologicalOrder(buildDependencyGraph([packageFixture('x', { x: '^1.0.0' })]))).toThrow(DependencyCycleError);
  });

  it('fails loudly when a cycle sits inside an otherwise orderable graph', () => {
    const call = () =>
      topologicalOrder(buildDependencyGraph([packageFixture('a'), packageFixture('p', { q: '^1.0.0' }), packageFixture('q', { p: '^1.0.0' })]));
    expect(call).toThrow(DependencyCycleError);
    expect(call).toThrow(/p -> q -> p|q -> p -> q/);
  });
});
