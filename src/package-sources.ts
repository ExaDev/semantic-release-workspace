import { ReleaseConfigurationError } from './errors';
import { type DependencyGraph } from './graph';
import { isJsonObject, isStringArray } from './json';

/** The extra repository paths whose commits count towards each package's release, by package name; see `resolvePackageSources`. Every package in the graph has an entry, empty for one that names none. */
export type PackageSourcePatterns = ReadonlyMap<string, readonly string[]>;

/**
 * Validates `packageSources` against the workspace and normalises it into one pattern list per package.
 *
 * Each pattern names a path or a glob relative to the git repository's toplevel (the base `git log --name-only` reports against), and counts a commit towards the package when the commit changed that path, a file under it, or a file matching it. Patterns use git's own glob pathspec syntax (`*` within a segment, `**` across segments), so they match files a commit deleted as well as files still on disk. A pattern that escapes the repository (any `..` segment), is absolute, uses a backslash, is empty, names the repository root, or consists only of wildcard segments (`*`, `**`, `?`) is rejected, because each would either read outside the repository or make every commit count for the package. A path segment cannot contain a literal glob character: the backslash that would escape one is refused.
 *
 * `undefined` leaves every package scoped to its own directory alone. Throws `ReleaseConfigurationError` for a name that is not a package in the workspace, a list that is not an array of strings, and each pattern rejected above, listing every offence at once.
 */
export function resolvePackageSources(graph: DependencyGraph, packageSources: Readonly<Record<string, readonly string[]>> | undefined): PackageSourcePatterns {
  const resolved = new Map<string, readonly string[]>([...graph.packages.keys()].map((name) => [name, []]));
  if (packageSources === undefined) {
    return resolved;
  }

  const problems: string[] = [];
  for (const [name, patterns] of Object.entries(packageSources)) {
    if (!resolved.has(name)) {
      problems.push(`"${name}" is not a package in this workspace (packages: ${[...graph.packages.keys()].join(', ')})`);
      continue;
    }
    const normalised: string[] = [];
    for (const pattern of patterns) {
      const result = normalisePattern(pattern);
      if (typeof result === 'string') {
        normalised.push(result);
      } else {
        problems.push(`${name}: ${JSON.stringify(pattern)} ${result.problem}`);
      }
    }
    resolved.set(name, [...new Set(normalised)]);
  }

  if (problems.length > 0) {
    throw new ReleaseConfigurationError(`packageSources is invalid: ${problems.join('; ')}.`);
  }
  return resolved;
}

/** Whether `value` has the shape `resolvePackageSources` takes: an object mapping package names to arrays of strings. */
export function isPackageSources(value: unknown): value is Record<string, string[]> {
  return isJsonObject(value) && Object.values(value).every((patterns) => isStringArray(patterns));
}

function normalisePattern(pattern: string): string | { readonly problem: string } {
  if (pattern.includes('\\')) {
    return { problem: 'contains a backslash; separate path segments with "/"' };
  }
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    return { problem: 'is an absolute path; give a path relative to the repository root' };
  }
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return { problem: 'escapes the repository with a ".." segment' };
  }
  if (segments.length === 0) {
    return { problem: 'names no path below the repository root, so every commit would count for the package' };
  }
  if (segments.every((segment) => /^[*?]+$/.test(segment))) {
    return { problem: 'has no literal path segment, so it would match every path in the repository; name the directory the sources live under' };
  }
  return segments.join('/');
}

/**
 * The git pathspecs that select the commits touching `patterns`: each pattern as a glob rooted at the repository toplevel, and again as `<pattern>/**` because a glob pathspec, unlike a literal one, does not match the files beneath a directory it names. Both are needed so `rust/crates/*` and `rust/crates/foo` each cover everything under what they name.
 */
export function toPathspecs(patterns: readonly string[]): readonly string[] {
  return patterns.flatMap((pattern) => [`:(top,glob)${pattern}`, `:(top,glob)${pattern}/**`]);
}
