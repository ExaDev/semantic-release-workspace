import semver from 'semver';
import { git, type GitCommandOptions } from './git';
import type { ReleasedTagSource } from './registry-recovery';
import { formatTagForPackage } from './tag-format';

/** One release of a package, as its tag records it. */
export interface ReleasedTag {
  readonly version: string;
  readonly gitTag: string;
}

const VERSION_PLACEHOLDER = '${version}';

/** Escapes every character `RegExp` treats as syntax, so a literal part of a tag template matches only itself. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every release of `name` tagged on the branch checked out in `options.cwd`, highest version first.
 *
 * Mirrors how semantic-release finds a release branch's last release: a tag counts when it matches the package's `tagFormat`, names a valid semver version and points at a commit the branch contains (`git tag --merged HEAD`), and a prerelease version counts for no release branch, so prereleases are left out. A template naming `${version}` more than once matches only tags that repeat the same version in every place.
 */
export async function releasedTags(name: string, tagFormat: string, options: GitCommandOptions): Promise<readonly ReleasedTag[]> {
  const template = formatTagForPackage(tagFormat, name);
  // The first placeholder captures the version and every later one must repeat it.
  const body = template
    .split(VERSION_PLACEHOLDER)
    .map(escapeRegExp)
    .reduce((joined, part, index) => (index === 0 ? part : `${joined}${index === 1 ? '(?<version>.+?)' : '\\k<version>'}${part}`), '');
  const pattern = new RegExp(`^${body}$`);
  const listed = await git(['tag', '--merged', 'HEAD', '--list', template.replaceAll(VERSION_PLACEHOLDER, '*')], options);

  const tags: ReleasedTag[] = [];
  for (const gitTag of listed.split('\n')) {
    const version = pattern.exec(gitTag)?.groups?.version;
    if (version !== undefined && semver.valid(version) === version && semver.prerelease(version) === null) {
      tags.push({ version, gitTag });
    }
  }
  return tags.sort((left, right) => semver.rcompare(left.version, right.version));
}

/** A `ReleasedTagSource` reading each package's release tags from the repository at `options.cwd`. */
export function createGitReleasedTagSource(tagFormat: string, options: GitCommandOptions): ReleasedTagSource {
  return {
    latestRelease: async (pkg) => (await releasedTags(pkg.name, tagFormat, options))[0],
  };
}
