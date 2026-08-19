import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';
import { WorkspaceDiscoveryError } from './errors';
import { isJsonObject, isStringArray } from './json';
import { type DependencyField, readManifest } from './manifest';

/** The one filename pnpm recognises as a workspace definition. */
const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';

/** Never treat an installed dependency's own manifest as a workspace package, however permissive the configured globs are. pnpm applies the same exclusion. */
const INSTALLED_PACKAGES = '**/node_modules/**';

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  /** Absolute path to the package directory. */
  readonly directory: string;
  /** Path relative to the workspace root, always POSIX-separated, because it is compared against the paths `git log` reports. */
  readonly relativeDirectory: string;
  readonly manifestPath: string;
  readonly dependencies: ReadonlyMap<DependencyField, ReadonlyMap<string, string>>;
}

export interface Workspace {
  /** Absolute path to the directory holding `pnpm-workspace.yaml`. */
  readonly root: string;
  /** Every discovered package, ordered by directory so discovery is reproducible regardless of filesystem iteration order. */
  readonly packages: readonly WorkspacePackage[];
}

/**
 * Reads `pnpm-workspace.yaml` and every package manifest its globs match, producing the input to both the dependency graph and the per-package release runs.
 *
 * Nothing here knows anything about a particular repository's layout: the globs come from the workspace file, and the package names, versions, and dependency ranges come from the manifests those globs match. Pointing this at any pnpm workspace is the entire configuration.
 */
export async function discoverWorkspace(root: string): Promise<Workspace> {
  const workspaceRoot = resolve(root);
  const patterns = await readWorkspacePatterns(workspaceRoot);

  const positive = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negative = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));

  const manifestPaths = await glob(positive.map(toManifestPattern), {
    cwd: workspaceRoot,
    absolute: true,
    // pnpm's globs name directories; expanding them again would turn `packages/*` into a recursive crawl that matches nested manifests the workspace never declared.
    expandDirectories: false,
    ignore: [...negative.flatMap((pattern) => [toManifestPattern(pattern), `${trimTrailingSlashes(pattern)}/**`]), INSTALLED_PACKAGES],
  });

  const packages: WorkspacePackage[] = [];
  const byName = new Map<string, string>();

  for (const manifestPath of [...manifestPaths].sort()) {
    const directory = dirname(manifestPath);
    const relativeDirectory = toPosix(relative(workspaceRoot, directory));
    if (relativeDirectory === '') {
      throw new WorkspaceDiscoveryError(`${WORKSPACE_MANIFEST} matches the workspace root itself. A package at the root cannot be scoped to its own commits, because every commit in the repository touches it; move it into a subdirectory or exclude it from the "packages" globs.`);
    }

    const manifest = await readManifest(manifestPath);
    const existing = byName.get(manifest.name);
    if (existing !== undefined) {
      throw new WorkspaceDiscoveryError(`Two workspace packages are both named "${manifest.name}": ${existing} and ${relativeDirectory}. Releases are matched to dependents by name, so names must be unique.`);
    }
    byName.set(manifest.name, relativeDirectory);

    packages.push({
      name: manifest.name,
      version: manifest.version,
      directory,
      relativeDirectory,
      manifestPath,
      dependencies: manifest.dependencies,
    });
  }

  if (packages.length === 0) {
    throw new WorkspaceDiscoveryError(`No packages matched the "packages" globs in ${resolve(workspaceRoot, WORKSPACE_MANIFEST)}.`);
  }

  return { root: workspaceRoot, packages };
}

async function readWorkspacePatterns(workspaceRoot: string): Promise<string[]> {
  const path = resolve(workspaceRoot, WORKSPACE_MANIFEST);
  const text = await readFile(path, 'utf8').catch((cause: unknown) => {
    throw new WorkspaceDiscoveryError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  });

  const parsed: unknown = parseYaml(text);
  if (!isJsonObject(parsed)) {
    throw new WorkspaceDiscoveryError(`${path} does not contain a YAML mapping.`);
  }

  const { packages } = parsed;
  if (!isStringArray(packages) || packages.length === 0) {
    throw new WorkspaceDiscoveryError(`${path} has no "packages" globs, so it defines no packages to release.`);
  }

  return packages;
}

/** pnpm's globs match package *directories*; the glob run here matches the manifest inside each of them, which is both what we need to read and the only reliable evidence a matched directory is a package at all. */
function toManifestPattern(pattern: string): string {
  return `${trimTrailingSlashes(pattern)}/package.json`;
}

const TRAILING_SLASHES = /\/+$/;

function trimTrailingSlashes(pattern: string): string {
  return pattern.replace(TRAILING_SLASHES, '');
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
