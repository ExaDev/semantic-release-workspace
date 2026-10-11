import type { ReleaseType } from 'semantic-release';

/** Every release type semantic-release knows, highest first: the order `@semantic-release/commit-analyzer` itself ranks them in (its `lib/default-release-types.js`), so comparing two types here agrees with how the analyzer picks the highest type among a package's own commits. */
const RELEASE_TYPES_HIGHEST_FIRST = ['major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease'] as const satisfies readonly ReleaseType[];

const KNOWN_RELEASE_TYPES: ReadonlySet<string> = new Set(RELEASE_TYPES_HIGHEST_FIRST);

/** Whether `value` is one of semantic-release's release types. */
export function isReleaseType(value: unknown): value is ReleaseType {
  return typeof value === 'string' && KNOWN_RELEASE_TYPES.has(value);
}

/** The highest of the given release types, ranked as `@semantic-release/commit-analyzer` ranks them, or `undefined` when `types` is empty. */
export function highestReleaseType(types: Readonly<Iterable<ReleaseType>>): ReleaseType | undefined {
  let highest: ReleaseType | undefined;
  for (const type of types) {
    if (highest === undefined || RELEASE_TYPES_HIGHEST_FIRST.indexOf(type) < RELEASE_TYPES_HIGHEST_FIRST.indexOf(highest)) {
      highest = type;
    }
  }
  return highest;
}

/** `base`, raised to `other` when `other` is the higher release type; an `undefined` `other` leaves `base` as it is. */
export function raiseReleaseType(base: ReleaseType, other: ReleaseType | undefined): ReleaseType {
  return other === undefined || RELEASE_TYPES_HIGHEST_FIRST.indexOf(base) <= RELEASE_TYPES_HIGHEST_FIRST.indexOf(other) ? base : other;
}
