import { DependencyCycleError } from './errors';
import { type DependencyField } from './manifest';
import { type WorkspacePackage } from './workspace';

/** One package's dependency on another package in the same workspace. */
export interface WorkspaceDependency {
  /** The depending package's name. */
  readonly dependent: string;
  /** The depended-upon package's name. */
  readonly dependency: string;
  readonly field: DependencyField;
  /** The range exactly as written in the dependent's manifest. */
  readonly range: string;
}

export interface DependencyGraph {
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  /** For each package, the workspace siblings it depends on. */
  readonly dependencies: ReadonlyMap<string, readonly WorkspaceDependency[]>;
  /** For each package, the workspace siblings that depend on it. */
  readonly dependents: ReadonlyMap<string, readonly WorkspaceDependency[]>;
}

/**
 * Builds the inter-package dependency graph from the manifests alone.
 *
 * A dependency on a package outside the workspace is not an edge: it neither constrains the release order nor gets rewritten when something here releases. A package that names itself becomes a self-edge, which `topologicalOrder` then reports as the one-package cycle it is, rather than being quietly dropped.
 */
export function buildDependencyGraph(packages: readonly WorkspacePackage[]): DependencyGraph {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const dependencies = new Map<string, WorkspaceDependency[]>(packages.map((pkg) => [pkg.name, []]));
  const dependents = new Map<string, WorkspaceDependency[]>(packages.map((pkg) => [pkg.name, []]));

  for (const pkg of packages) {
    const outgoing = dependencies.get(pkg.name);
    if (outgoing === undefined) {
      continue;
    }
    for (const [field, declared] of pkg.dependencies) {
      for (const [name, range] of declared) {
        const incoming = dependents.get(name);
        if (incoming === undefined) {
          continue;
        }
        const edge: WorkspaceDependency = { dependent: pkg.name, dependency: name, field, range };
        outgoing.push(edge);
        incoming.push(edge);
      }
    }
  }

  return { packages: byName, dependencies, dependents };
}

/**
 * Orders packages so every package appears after every workspace sibling it depends on, using Kahn's algorithm.
 *
 * Packages whose dependencies have all been placed are taken in name order, so the same workspace always produces the same order -- a release run that reorders itself between CI runs is impossible to reason about when something goes wrong halfway through.
 *
 * A cycle has no valid order at all, so it throws rather than picking one of the wrong answers. In a release context an arbitrary order is worse than a failure: it would publish a package whose sibling dependency range points at a version that does not exist yet.
 */
export function topologicalOrder(graph: DependencyGraph): readonly string[] {
  const pending = new Map<string, Set<string>>();
  for (const [name, edges] of graph.dependencies) {
    pending.set(name, new Set(edges.map((edge) => edge.dependency)));
  }

  const ordered: string[] = [];
  for (;;) {
    const ready = [...pending].filter(([, unplaced]) => unplaced.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      break;
    }
    for (const name of ready) {
      pending.delete(name);
      ordered.push(name);
    }
    for (const unplaced of pending.values()) {
      for (const name of ready) {
        unplaced.delete(name);
      }
    }
  }

  if (pending.size > 0) {
    throw new DependencyCycleError(findCycle(graph, new Set(pending.keys())));
  }

  return ordered;
}

/**
 * Walks dependency edges between the packages Kahn's algorithm could not place, until it revisits one, so the error can name a concrete loop rather than just a set of packages. Every unplaced package is unplaced precisely because at least one of its own dependencies is too, so the walk always reaches a repeat.
 */
function findCycle(graph: DependencyGraph, unplaced: ReadonlySet<string>): readonly string[] {
  const path: string[] = [];
  const onPath = new Set<string>();
  let current = firstUnplacedDependency(undefined, graph, unplaced);

  while (current !== undefined && !onPath.has(current)) {
    path.push(current);
    onPath.add(current);
    current = firstUnplacedDependency(current, graph, unplaced);
  }

  return current === undefined ? path : [...path.slice(path.indexOf(current)), current];
}

/** With no package given, the alphabetically first unplaced package (the walk's starting point); otherwise that package's alphabetically first still-unplaced dependency. Sorting keeps the reported cycle stable across runs. */
function firstUnplacedDependency(name: string | undefined, graph: DependencyGraph, unplaced: ReadonlySet<string>): string | undefined {
  if (name === undefined) {
    return [...unplaced].sort()[0];
  }
  const edges = graph.dependencies.get(name) ?? [];
  return edges.map((edge) => edge.dependency).filter((dependency) => unplaced.has(dependency)).sort()[0];
}
