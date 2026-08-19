import { readFile, writeFile } from 'node:fs/promises';
import validateNpmPackageName from 'validate-npm-package-name';
import { WorkspaceDiscoveryError } from './errors';
import { isJsonObject, isStringRecord, stringifyJsonLike } from './json';

/**
 * The manifest fields that can name a workspace sibling.
 *
 * All four contribute edges to the release order: whatever field a dependency sits in, the sibling has to have released before the dependent's manifest can name its new version. All four also contribute to the decision to release a dependent (see `releaseWorkspace`), because pnpm rewrites `workspace:` ranges in every one of them at pack time -- a `devDependencies` entry is part of the published artifact even though consumers never install it.
 */
export type DependencyField = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

export const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  /** Only the fields actually present in the file, each mapping dependency name to its declared range. */
  readonly dependencies: ReadonlyMap<DependencyField, ReadonlyMap<string, string>>;
}

export async function readManifest(path: string): Promise<PackageManifest> {
  const text = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new WorkspaceDiscoveryError(`${path} does not contain a JSON object.`);
  }

  const { name, version } = parsed;
  if (typeof name !== 'string' || name.length === 0) {
    throw new WorkspaceDiscoveryError(`${path} has no "name". Every workspace package needs a name: releases are ordered, tagged, and matched to dependents by it.`);
  }
  // The name is spliced verbatim into a lodash template (semantic-release's `tagFormat`), so it must be restricted to npm's own package-name rules -- which exclude every lodash template delimiter -- before it ever reaches that template, not merely "non-empty".
  const validity = validateNpmPackageName(name);
  if (!validity.validForOldPackages) {
    throw new WorkspaceDiscoveryError(`${path} has an invalid "name" ("${name}"): ${(validity.errors ?? []).join('; ')}`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new WorkspaceDiscoveryError(`${path} has no "version".`);
  }

  const dependencies = new Map<DependencyField, ReadonlyMap<string, string>>();
  for (const field of DEPENDENCY_FIELDS) {
    const declared = parsed[field];
    if (declared === undefined) {
      continue;
    }
    if (!isStringRecord(declared)) {
      throw new WorkspaceDiscoveryError(`${path} has a "${field}" field that is not an object of name-to-range strings.`);
    }
    dependencies.set(field, new Map(Object.entries(declared)));
  }

  return { name, version, dependencies };
}

/**
 * Rewrites one dependency range in a manifest on disk.
 *
 * Deliberately re-reads the file rather than editing a copy held from discovery time: by the time a cross-package bump is applied, semantic-release's own `@semantic-release/npm` prepare step may already have rewritten `version` in this same file for an earlier package in the run. Writing back a manifest parsed before that would silently revert it.
 */
export async function writeDependencyRange(path: string, field: DependencyField, dependency: string, range: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new WorkspaceDiscoveryError(`${path} does not contain a JSON object.`);
  }

  const declared = parsed[field];
  if (!isStringRecord(declared)) {
    throw new WorkspaceDiscoveryError(`${path} no longer has a "${field}" object holding "${dependency}".`);
  }

  declared[dependency] = range;
  await writeFile(path, stringifyJsonLike(parsed, text), 'utf8');
}
