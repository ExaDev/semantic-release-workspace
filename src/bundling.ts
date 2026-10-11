import { ReleaseConfigurationError } from './errors';
import { type DependencyGraph, mustGet, type WorkspaceDependency } from './graph';

/**
 * Which of a package's workspace dependencies ship inside its published artefact, as far as release types are concerned. Built by `resolveBundledDependencies`.
 */
export interface BundledDependencies {
  /**
   * The dependencies whose release type sets this package's own when they release: every workspace sibling in the `devDependencies` of a package named in `bundlingPackages`. Empty for every other package, which keeps the forced patch release a dependency bump has always given it.
   */
  readonly releaseTypeFrom: ReadonlySet<string>;
  /**
   * The dependencies whose shipped release type this package passes on to whatever bundles it: everything in `releaseTypeFrom`, plus, for a private package, every private sibling in its `dependencies`, `peerDependencies` or `optionalDependencies`. A private package is never installed from the registry, and neither is a private sibling it needs at run time, so a bundle that inlines the one inlines the other too.
   */
  readonly carried: ReadonlySet<string>;
}

/**
 * Validates `bundlingPackages` against the workspace and works out, for every package, which workspace dependencies it bundles.
 *
 * A package named in `bundlingPackages` declares that its build inlines every workspace sibling it lists in `devDependencies`, so consumers never install those siblings from the registry and their code reaches consumers only through this package. When such a sibling releases, this package's release type is at least the sibling's shipped release type (a `feat` in the sibling releases this package as a minor), instead of the patch an ordinary dependency bump forces. Edges in `dependencies`, `peerDependencies` and `optionalDependencies` are installed by consumers, so they keep the forced patch.
 *
 * A private package's own release type never changes: it keeps the patch a dependency bump forces, so its versions and tags are exactly what they would be without `bundlingPackages`. What it gains is a carried release type (see `BundledDependencies.carried`), which lets a bundling package that lists only the private package still see the release type of a private sibling the private package depends on.
 *
 * `bundlingPackages` names public workspace packages whose builds bundle their workspace `devDependencies`; `undefined` or an empty list leaves every package's release type as it was. Returns one entry per package in the graph. Throws `ReleaseConfigurationError` when a name is not a package in the workspace, or names a private package, which never publishes and so ships nothing to consumers.
 */
export function resolveBundledDependencies(graph: DependencyGraph, bundlingPackages: readonly string[] | undefined): ReadonlyMap<string, BundledDependencies> {
  const bundling = new Set(bundlingPackages);

  const unknown = [...bundling].filter((name) => !graph.packages.has(name));
  if (unknown.length > 0) {
    throw new ReleaseConfigurationError(
      `bundlingPackages names ${unknown.map((name) => `"${name}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not a package in this workspace. Packages: ${[...graph.packages.keys()].join(', ')}.`,
    );
  }
  const privateNames = [...bundling].filter((name) => mustGet(graph.packages, name, 'package').private);
  if (privateNames.length > 0) {
    throw new ReleaseConfigurationError(
      `bundlingPackages names ${privateNames.map((name) => `"${name}"`).join(', ')}, which ${privateNames.length === 1 ? 'is' : 'are'} private. A private package is never published, so nothing it bundles reaches a consumer through it; list the public package whose build inlines it instead.`,
    );
  }

  const resolved = new Map<string, BundledDependencies>();
  for (const [name, pkg] of graph.packages) {
    const edges = graph.dependencies.get(name) ?? [];
    const releaseTypeFrom = new Set(edges.filter((edge) => bundling.has(name) && edge.field === 'devDependencies').map((edge) => edge.dependency));
    const carried = new Set([...releaseTypeFrom, ...edges.filter((edge) => pkg.private && isPrivateRuntimeEdge(edge, graph)).map((edge) => edge.dependency)]);
    resolved.set(name, { releaseTypeFrom, carried });
  }
  return resolved;
}

function isPrivateRuntimeEdge(edge: WorkspaceDependency, graph: DependencyGraph): boolean {
  return edge.field !== 'devDependencies' && mustGet(graph.packages, edge.dependency, 'package').private;
}
