import { UnsupportedDependencyRangeError } from './errors';

/**
 * What happens to one dependency range when the sibling it points at releases a new version.
 *
 * The distinction between `rewritten` and `resolved-at-publish` matters for the manifest, not for the release decision: both mean the dependent's *published* dependency range changes, and therefore that the dependent needs a release of its own for that change to reach consumers. Only `wildcard` leaves the published artifact genuinely identical.
 */
export type DependencyRangeUpdate =
  /** The range names a concrete version that has to be rewritten in the manifest. */
  | { readonly kind: 'rewritten'; readonly range: string }
  /** A bare `workspace:*`, `workspace:^`, or `workspace:~` range: pnpm substitutes the sibling's current version at pack time, so the manifest on disk needs no edit even though the published range does change. */
  | { readonly kind: 'resolved-at-publish' }
  /** A range naming no version at all (`*`, `x`, `latest`). Nothing to rewrite, and the published range is unaffected by the sibling's new version. */
  | { readonly kind: 'wildcard' };

const WORKSPACE_PROTOCOL = 'workspace:';
const CATALOG_PROTOCOL = 'catalog:';
const NPM_ALIAS_PROTOCOL = 'npm:';

/** The `workspace:` suffixes pnpm resolves against the sibling's version at pack time rather than against anything written in the manifest. */
const PUBLISH_RESOLVED_WORKSPACE_SUFFIXES: readonly string[] = ['*', '^', '~'];

/** Ranges that pin nothing, so a sibling's new version cannot change what they mean. */
const WILDCARD_RANGES: readonly string[] = ['', '*', 'x', 'X', 'latest'];

/**
 * A single comparator whose version can be replaced in place without changing the comparator's intent. `<` and `<=` are deliberately absent: rewriting `<2.0.0` to `<1.4.0` narrows an upper bound to the very version being released, which is never what the author meant, so such a range is rejected rather than mangled.
 */
const REWRITABLE_COMPARATOR = /^(\^|~|>=|=)?(\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?)$/;

/**
 * What a dependency range's own shape supports, independent of any particular version -- the classification that decides whether `updateDependencyRange` can succeed at all, split out so it can be checked for every workspace dependency edge before a release run starts, not just when the range's sibling actually releases.
 */
export type DependencyRangeShape =
  | { readonly kind: 'rewritable'; readonly workspacePrefixed: boolean; readonly comparator: string }
  | { readonly kind: 'resolved-at-publish' }
  | { readonly kind: 'wildcard' };

/**
 * Classifies a dependency range's shape, throwing `UnsupportedDependencyRangeError` for anything this tool cannot rewrite with confidence: a compound range (`>=1.0.0 <2.0.0`), a union (`1.x || 2.x`), a `catalog:` reference whose real version lives in `pnpm-workspace.yaml`, an `npm:` alias, a git or tarball URL. Guessing at those would either corrupt the range or silently leave it pointing at a version that no longer exists in the workspace, and a stale published range is exactly the divergence this tool exists to prevent.
 *
 * This never needs the version a sibling is releasing: every case above depends only on the shape of `current` itself, which is what lets `releaseWorkspace` validate every workspace dependency edge up front, before any package has published anything, rather than discovering an unsupported range only when the first dependency it names happens to release.
 */
export function classifyDependencyRange(current: string): DependencyRangeShape {
  const range = current.trim();

  if (range.startsWith(WORKSPACE_PROTOCOL)) {
    const suffix = range.slice(WORKSPACE_PROTOCOL.length);
    if (PUBLISH_RESOLVED_WORKSPACE_SUFFIXES.includes(suffix)) {
      return { kind: 'resolved-at-publish' };
    }
    const inner = classifyDependencyRange(suffix);
    if (inner.kind !== 'rewritable') {
      throw new UnsupportedDependencyRangeError(`Cannot bump the workspace dependency range "${current}": only "workspace:*", "workspace:^", "workspace:~", and "workspace:" followed by a single concrete version range are supported.`);
    }
    return { kind: 'rewritable', workspacePrefixed: true, comparator: inner.comparator };
  }

  if (range.startsWith(CATALOG_PROTOCOL)) {
    throw new UnsupportedDependencyRangeError(`Cannot bump the workspace dependency range "${current}": the version of a "catalog:" dependency lives in pnpm-workspace.yaml, not in the package manifest, so bumping it here would leave the catalog entry stale. Depend on the sibling directly (for example "workspace:^") instead.`);
  }

  if (range.startsWith(NPM_ALIAS_PROTOCOL)) {
    throw new UnsupportedDependencyRangeError(`Cannot bump the workspace dependency range "${current}": an "npm:" alias points at a differently-named package, so the version released in this workspace is not necessarily the version this range refers to.`);
  }

  if (WILDCARD_RANGES.includes(range)) {
    return { kind: 'wildcard' };
  }

  const match = REWRITABLE_COMPARATOR.exec(range);
  if (match === null) {
    throw new UnsupportedDependencyRangeError(`Cannot bump the workspace dependency range "${current}": only a single "^", "~", ">=", "=", or bare version comparator can be rewritten in place.`);
  }

  return { kind: 'rewritable', workspacePrefixed: false, comparator: match[1] ?? '' };
}

/**
 * Computes what a dependency range on a workspace sibling becomes once that sibling releases `version`, by classifying the range's shape and then, for a rewritable shape, substituting `version` in place of the version it currently names.
 */
export function updateDependencyRange(current: string, version: string): DependencyRangeUpdate {
  const shape = classifyDependencyRange(current);
  if (shape.kind !== 'rewritable') {
    return shape;
  }
  const rewritten = `${shape.comparator}${version}`;
  return { kind: 'rewritten', range: shape.workspacePrefixed ? `${WORKSPACE_PROTOCOL}${rewritten}` : rewritten };
}
