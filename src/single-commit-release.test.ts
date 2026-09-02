import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError } from './errors';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { type PublishPluginSpec } from './plugins';
import { releaseWorkspace } from './release';

/**
 * @semantic-release/changelog and @semantic-release/npm (with npmPublish false) are enough to exercise the real "prepare" path (version bump + changelog write) and the real "publish"/"verifyConditions" path (both skip real registry/network calls when npmPublish is false, exactly like release.test.ts's own FIXTURE_PLUGINS) without ever touching the npm registry or GitHub. @semantic-release/git is deliberately absent: commitStrategy "single" rejects it outright (see the dedicated test below).
 */
const SINGLE_FIXTURE_PLUGINS: readonly PublishPluginSpec[] = ['@semantic-release/changelog', ['@semantic-release/npm', { npmPublish: false }]];

/** Identical to release.test.ts's own releaseEnv: strips every CI-service marker the test runner's own CI sets so env-ci does not mistake it for the release run's CI, then re-adds CI=true so semantic-release runs in real (non-dry) mode reading the branch from the local git repository. */
function releaseEnv(): NodeJS.ProcessEnv {
  const CI_SERVICE_PREFIX =
    /^(GITHUB|GITLAB|CIRCLE|TRAVIS|BUILDKITE|APPVEYOR|TEAMCITY|JENKINS|DRONE|NETLIFY|VERCEL|SAIL|WOODPECKER|BITBUCKET|BITRISE|BAMBOO|AZURE|CODEBUILD|CODEFRESH|CODESHIP|CIRRUS|SCRUTINIZER|SEMAPHORE|SHIPYABLE|WERCKER|VELA|BUDDY|JETBRAINS)_/;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CI' && key !== 'CI_NAME' && key !== 'CIRCLECI' && !CI_SERVICE_PREFIX.test(key)) {
      env[key] = value;
    }
  }
  env.CI = 'true';
  return env;
}

const chainPackages: readonly FixturePackage[] = [
  { name: '@fixture/a', version: '1.0.0' },
  { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } },
  { name: '@fixture/c', version: '1.0.0', dependencies: { '@fixture/b': '^1.0.0' } },
];

describe('releaseWorkspace with commitStrategy "single"', () => {
  it('folds every release, dependency bump, and changelog into one commit, tagged once per released package', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat: workspace-wide readme', files: { 'README.md': '# fixture workspace\n' } },
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });

      expect(outcome.order).toEqual(['@fixture/a', '@fixture/b', '@fixture/c']);
      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
      expect(byName.get('@fixture/b')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [{ dependent: '@fixture/b', dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', kind: 'rewritten' }],
      });
      expect(byName.get('@fixture/c')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [{ dependent: '@fixture/c', dependency: '@fixture/b', version: '1.0.1', range: '^1.0.1', kind: 'rewritten' }],
      });

      // Exactly one new commit landed on top of the fixture's own scaffolding, and every tag points at it.
      const headAfter = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      expect(headAfter).not.toBe(headBefore);
      const newCommitCount = (await git(['rev-list', '--count', `${headBefore}..${headAfter}`], { cwd: fixture.root })).trim();
      expect(newCommitCount).toBe('1');
      const subject = (await git(['log', '-1', '--format=%s', headAfter], { cwd: fixture.root })).trim();
      expect(subject).toBe('chore(release): batch release [skip ci]');

      for (const tag of ['@fixture/a@1.1.0', '@fixture/b@1.0.1', '@fixture/c@1.0.1']) {
        const tagSha = (await git(['rev-parse', tag], { cwd: fixture.root })).trim();
        expect(tagSha).toBe(headAfter);
        expect(await git(['cat-file', '-t', tag], { cwd: fixture.root })).toBe('commit\n');
      }

      // Pushed to the remote too: same commit, same tags.
      const remoteHead = (await git(['rev-parse', 'main'], { cwd: fixture.remote })).trim();
      expect(remoteHead).toBe(headAfter);
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n').filter(Boolean).sort();
      expect(remoteTags).toEqual(expect.arrayContaining(['@fixture/a@1.1.0', '@fixture/b@1.0.1', '@fixture/c@1.0.1']));

      // Dependency ranges rewritten and versions bumped on disk, in the one commit.
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.1.0');
      await expect(manifestDependency(fixture.root, '@fixture/c', '@fixture/b')).resolves.toBe('^1.0.1');
      await expect(manifestVersion(fixture.root, '@fixture/a')).resolves.toBe('1.1.0');
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
      await expect(manifestVersion(fixture.root, '@fixture/c')).resolves.toBe('1.0.1');

      // Each package's own CHANGELOG.md is scoped to its own release only -- not to what the whole run did.
      const changelogA = await readFile(join(fixture.root, 'packages/a/CHANGELOG.md'), 'utf8');
      expect(changelogA).toMatch(/second feature/);
      expect(changelogA).not.toMatch(/Dependencies/);
      const changelogB = await readFile(join(fixture.root, 'packages/b/CHANGELOG.md'), 'utf8');
      expect(changelogB).toMatch(/Dependencies/);
      expect(changelogB).toMatch(/@fixture\/a/);
      expect(changelogB).not.toMatch(/second feature/);

      // Every file the run touched is committed -- nothing left dirty.
      const status = await git(['status', '--porcelain'], { cwd: fixture.root });
      expect(status.trim()).toBe('');
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('releases only the package with changes; the packages upstream of it release nothing and nothing is committed for them', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(c): standalone feature', files: { 'packages/c/src/index.js': 'export const c = 2;\n' } },
    ]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });
      expect(outcome.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
        ['@fixture/a', undefined],
        ['@fixture/b', undefined],
        ['@fixture/c', '1.1.0'],
      ]);
      const tagSha = (await git(['rev-parse', '@fixture/c@1.1.0'], { cwd: fixture.root })).trim();
      const headAfter = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      expect(tagSha).toBe(headAfter);
      await expect(git(['rev-parse', '@fixture/a@1.1.0'], { cwd: fixture.root })).rejects.toThrow();
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('reports the same cascade in a dry run, including the forced dependency patches, without writing, committing, tagging, or pushing anything', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });

      expect(outcome.packages.map((pkg) => [pkg.name, pkg.version, pkg.type])).toEqual([
        ['@fixture/a', '1.1.0', 'minor'],
        ['@fixture/b', '1.0.1', 'patch'],
        ['@fixture/c', '1.0.1', 'patch'],
      ]);

      const headAfter = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      expect(headAfter).toBe(headBefore);
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.0.0');
      const status = await git(['status', '--porcelain'], { cwd: fixture.root });
      expect(status.trim()).toBe('');
      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort();
      expect(localTags).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0', '@fixture/c@1.0.0']);
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('finds nothing to release, and makes no commit at all, on a second run over already-released state', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });
      const headAfterFirst = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

      const second = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });
      expect(second.packages.map((pkg) => [pkg.name, pkg.released])).toEqual([
        ['@fixture/a', false],
        ['@fixture/b', false],
        ['@fixture/c', false],
      ]);
      const headAfterSecond = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();
      expect(headAfterSecond).toBe(headAfterFirst);
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('rejects @semantic-release/git in the plugin list, since this mode does its own committing', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, []);
    try {
      const failure = releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        commitStrategy: 'single',
        plugins: [['@semantic-release/git', { assets: ['package.json'] }]],
      });
      await expect(failure).rejects.toBeInstanceOf(ReleaseConfigurationError);
      await expect(failure).rejects.toThrow(/@semantic-release\/git/);

      // Nothing published: the run fails before analysis even starts.
      const log = await git(['log', '--oneline', 'main'], { cwd: fixture.root });
      expect(log.split('\n').filter(Boolean)).toHaveLength(4);
    } finally {
      await fixture.remove();
    }
  }, 60_000);
});

async function readManifest(root: string, packageName: string): Promise<Record<string, unknown>> {
  const path = join(root, 'packages', packageName.slice(packageName.indexOf('/') + 1), 'package.json');
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isJsonObject(parsed)) {
    throw new Error(`Fixture manifest ${path} is not a JSON object.`);
  }
  return parsed;
}

async function manifestVersion(root: string, packageName: string): Promise<string> {
  const manifest = await readManifest(root, packageName);
  if (typeof manifest.version !== 'string') {
    throw new Error(`Fixture manifest for ${packageName} has no string version.`);
  }
  return manifest.version;
}

async function manifestDependency(root: string, packageName: string, dependency: string): Promise<string> {
  const manifest = await readManifest(root, packageName);
  const dependencies = manifest.dependencies;
  if (!isJsonObject(dependencies) || typeof dependencies[dependency] !== 'string') {
    throw new Error(`Fixture manifest for ${packageName} has no string dependency on ${dependency}.`);
  }
  return dependencies[dependency];
}
