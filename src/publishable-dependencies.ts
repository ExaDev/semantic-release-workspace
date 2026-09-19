import { UnsupportedDependencyRangeError } from './errors';
import { INSTALLED_DEPENDENCY_FIELDS, type PackageManifest } from './manifest';
import { unpublishableSpecifierProtocol } from './version-range';

/** The parts of a manifest the publishability check reads, so it accepts a discovered `WorkspacePackage` and a freshly read `PackageManifest` alike. */
export type PublishableManifest = Pick<PackageManifest, 'name' | 'private' | 'dependencies'>;

/**
 * Throws `UnsupportedDependencyRangeError` unless every publishable package's installed dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`) are ranges a consumer's package manager can resolve.
 *
 * Publishing goes through `@semantic-release/npm`, that is plain `npm publish`, which copies the manifest's specifiers into the registry unchanged. A `workspace:`, `catalog:`, `link:`, or `file:` specifier therefore reaches consumers as written and makes the package uninstallable, whichever sibling or external package it names and whether or not the tool would have rewritten it. `pnpm publish` would substitute some of them at pack time, but this tool never packs with pnpm, so accepting them would mean publishing a broken package with no warning.
 *
 * A `private` package never publishes and is exempt, and so is `devDependencies`, which no consumer installs. Every offending entry across every package is reported in one error, so a workspace with several of them is fixed in one pass rather than one failed run per entry.
 */
export function assertPublishableDependencies(packages: readonly PublishableManifest[]): void {
  const offences: string[] = [];

  for (const pkg of packages) {
    if (pkg.private) {
      continue;
    }
    for (const field of INSTALLED_DEPENDENCY_FIELDS) {
      const declared = pkg.dependencies.get(field);
      if (declared === undefined) {
        continue;
      }
      for (const [dependency, specifier] of declared) {
        if (unpublishableSpecifierProtocol(specifier) !== undefined) {
          offences.push(`  ${pkg.name}: "${dependency}" in ${field} is declared as "${specifier}"`);
        }
      }
    }
  }

  if (offences.length > 0) {
    throw new UnsupportedDependencyRangeError(
      `Refusing to release: npm publish ships these dependency specifiers unchanged, so the published package could not be installed.\n${offences.join('\n')}\nDeclare a plain version range instead (for example "^1.2.3"). For a sibling in this workspace, keep "linkWorkspacePackages: true" in pnpm-workspace.yaml so pnpm still links it locally; this tool rewrites the range whenever the sibling releases. Packages marked "private" are never published and are exempt.`,
    );
  }
}
