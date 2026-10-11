import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDependencyBumpMessage } from './dependency-bump-commit';
import { git } from './git';
import { type FixtureCommit, type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { writeDependencyRange } from './manifest';
import { type PublishPluginSpec } from './plugins';
import { releaseWorkspace, type ReleaseWorkspaceOptions } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

/** Offline publish pipeline, as in `release.test.ts`: `@semantic-release/npm` writes the version without publishing, `@semantic-release/git` makes the real release commit. */
const FIXTURE_PLUGINS: readonly PublishPluginSpec[] = [
  ['@semantic-release/npm', { npmPublish: false }],
  ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
];

/** The process-graph shape: one public package that inlines two private workspace packages and lists them in `devDependencies` at exact versions. */
const bundlingPackages: readonly FixturePackage[] = [
  { name: '@fixture/core', version: '1.0.0' },
  { name: '@fixture/util', version: '1.0.0' },
  { name: '@fixture/app', version: '1.0.0', private: false, devDependencies: { '@fixture/core': '1.0.0', '@fixture/util': '1.0.0' } },
];

const feat = (directory: string): FixtureCommit => ({ message: `feat(${directory}): add a feature`, files: { [`packages/${directory}/src/index.js`]: `export const feature = '${directory}';\n` } });
const fix = (directory: string): FixtureCommit => ({ message: `fix(${directory}): fix a bug`, files: { [`packages/${directory}/src/fix.js`]: `export const fixed = '${directory}';\n` } });
const breaking = (directory: string): FixtureCommit => ({
  message: `feat(${directory}): replace the interface\n\nBREAKING CHANGE: the old interface is gone`,
  files: { [`packages/${directory}/src/index.js`]: `export const replaced = '${directory}';\n` },
});

/** Runs a dry release of `packages` after `commits` and reports each package's computed release type and version, keyed by name. */
async function dryRunReleases(
  packages: readonly FixturePackage[],
  commits: readonly FixtureCommit[],
  options: Pick<ReleaseWorkspaceOptions, 'bundlingPackages' | 'commitStrategy'>,
): Promise<ReadonlyMap<string, { readonly type: string | undefined; readonly version: string | undefined }>> {
  const fixture = await createWorkspaceFixture(packages, commits);
  try {
    const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [], ...options });
    return new Map(outcome.packages.map((pkg) => [pkg.name, { type: pkg.type, version: pkg.version }]));
  } finally {
    await fixture.remove();
  }
}

describe('bundlingPackages against a real git workspace', () => {
  it('releases the bundling package as a minor when a bundled private package gains a feature', async () => {
    const releases = await dryRunReleases(bundlingPackages, [feat('core')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/core')).toEqual({ type: 'minor', version: '1.1.0' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'minor', version: '1.1.0' });
  }, TestTimeoutMs.Long);

  it('releases the bundling package as a patch when a bundled package only fixes a bug', async () => {
    const releases = await dryRunReleases(bundlingPackages, [fix('core')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/app')).toEqual({ type: 'patch', version: '1.0.1' });
  }, TestTimeoutMs.Long);

  it('releases the bundling package as a major when a bundled package breaks its interface', async () => {
    const releases = await dryRunReleases(bundlingPackages, [breaking('core')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/core')).toEqual({ type: 'major', version: '2.0.0' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'major', version: '2.0.0' });
  }, TestTimeoutMs.Long);

  it('takes the highest release type when several bundled packages release', async () => {
    const releases = await dryRunReleases(bundlingPackages, [fix('util'), feat('core')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/util')).toEqual({ type: 'patch', version: '1.0.1' });
    expect(releases.get('@fixture/core')).toEqual({ type: 'minor', version: '1.1.0' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'minor', version: '1.1.0' });
  }, TestTimeoutMs.Long);

  it('takes the higher of its own release type and the bundled one when the bundling package has releasable commits', async () => {
    const raisedByBundled = await dryRunReleases(bundlingPackages, [fix('app'), breaking('core')], { bundlingPackages: ['@fixture/app'] });
    expect(raisedByBundled.get('@fixture/app')).toEqual({ type: 'major', version: '2.0.0' });

    const keptOwn = await dryRunReleases(bundlingPackages, [feat('app'), fix('core')], { bundlingPackages: ['@fixture/app'] });
    expect(keptOwn.get('@fixture/app')).toEqual({ type: 'minor', version: '1.1.0' });
  }, TestTimeoutMs.Long);

  it('keeps the forced patch for an ordinary dependencies edge, even on a bundling package', async () => {
    const installing: readonly FixturePackage[] = [
      { name: '@fixture/lib', version: '1.0.0', private: false },
      { name: '@fixture/app', version: '1.0.0', private: false, dependencies: { '@fixture/lib': '^1.0.0' } },
    ];
    const releases = await dryRunReleases(installing, [feat('lib')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/lib')).toEqual({ type: 'minor', version: '1.1.0' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'patch', version: '1.0.1' });
  }, TestTimeoutMs.Long);

  it('keeps the forced patch for a devDependencies edge when the dependent is not named as bundling', async () => {
    const releases = await dryRunReleases(bundlingPackages, [feat('core')], {});
    expect(releases.get('@fixture/app')).toEqual({ type: 'patch', version: '1.0.1' });
  }, TestTimeoutMs.Long);

  it('carries a release type through a private package the bundling package lists, without changing that private package', async () => {
    const indirect: readonly FixturePackage[] = [
      { name: '@fixture/deep', version: '1.0.0' },
      { name: '@fixture/mid', version: '1.0.0', dependencies: { '@fixture/deep': 'workspace:*' } },
      { name: '@fixture/app', version: '1.0.0', private: false, devDependencies: { '@fixture/mid': '1.0.0' } },
    ];
    const releases = await dryRunReleases(indirect, [feat('deep')], { bundlingPackages: ['@fixture/app'] });
    expect(releases.get('@fixture/deep')).toEqual({ type: 'minor', version: '1.1.0' });
    // The private intermediate keeps the forced patch, exactly as without bundlingPackages.
    expect(releases.get('@fixture/mid')).toEqual({ type: 'patch', version: '1.0.1' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'minor', version: '1.1.0' });
  }, TestTimeoutMs.Long);

  it('computes the same release types under commitStrategy "single"', async () => {
    const releases = await dryRunReleases(bundlingPackages, [fix('util'), breaking('core')], { bundlingPackages: ['@fixture/app'], commitStrategy: 'single' });
    expect(releases.get('@fixture/app')).toEqual({ type: 'major', version: '2.0.0' });
  }, TestTimeoutMs.Long);

  it('computes the same release types when publishing is gated', async () => {
    const fixture = await createWorkspaceFixture(bundlingPackages, [breaking('core')]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, gatePublish: true, bundlingPackages: ['@fixture/app'] });
      const app = outcome.detached?.find((entry) => entry.name === '@fixture/app');
      expect(app?.state?.nextRelease).toMatchObject({ type: 'major', version: '2.0.0' });
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('tags and keeps private only what it did before, and records the release type in the bump commit', async () => {
    const fixture = await createWorkspaceFixture(bundlingPackages, [feat('core')]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, bundlingPackages: ['@fixture/app'] });
      expect(outcome.packages.map((pkg) => [pkg.name, pkg.released, pkg.version])).toEqual([
        ['@fixture/core', true, '1.1.0'],
        ['@fixture/util', false, undefined],
        ['@fixture/app', true, '1.1.0'],
      ]);

      // The tags are exactly those of the packages that released, one each, with the private package's version its own feat gave it.
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n').filter(Boolean).sort();
      expect(remoteTags).toEqual(['@fixture/app@1.0.0', '@fixture/app@1.1.0', '@fixture/core@1.0.0', '@fixture/core@1.1.0', '@fixture/util@1.0.0']);
      await expect(manifestField(fixture.root, 'core', 'private')).resolves.toBe(true);
      await expect(manifestField(fixture.root, 'util', 'private')).resolves.toBe(true);

      const bumpMessage = await git(['log', '-1', '--format=%B', '--grep=^chore(deps): bump @fixture/core', 'main'], { cwd: fixture.root });
      expect(bumpMessage).toContain('Bumped-Workspace-Dependency-Release-Type: minor');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('recovers the bundled release type from a bump commit a previous run pushed', async () => {
    const fixture = await createWorkspaceFixture(bundlingPackages, [feat('core')]);
    try {
      // The state a run that stopped between core's release and app's turn leaves behind: core released and tagged, app's manifest bumped and pushed, and nothing in memory.
      await writeManifestVersion(fixture.root, 'core', '1.1.0');
      await git(['add', '--', 'packages/core/package.json'], { cwd: fixture.root });
      await git(['commit', '-m', 'chore(release): @fixture/core@1.1.0 [skip ci]'], { cwd: fixture.root });
      await git(['tag', '@fixture/core@1.1.0'], { cwd: fixture.root });
      await writeDependencyRange(join(fixture.root, 'packages/app/package.json'), 'devDependencies', '@fixture/core', '1.1.0');
      await git(['add', '--', 'packages/app/package.json'], { cwd: fixture.root });
      await git(['commit', '-m', formatDependencyBumpMessage({ dependency: '@fixture/core', version: '1.1.0', range: '1.1.0', releaseType: 'minor', dependent: '@fixture/app' })], {
        cwd: fixture.root,
      });
      await git(['push', 'origin', 'main', '--tags'], { cwd: fixture.root });

      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [], bundlingPackages: ['@fixture/app'] });
      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/core')).toMatchObject({ released: false });
      expect(byName.get('@fixture/app')).toMatchObject({ released: true, type: 'minor', version: '1.1.0' });
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});

async function readManifest(root: string, directory: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'));
  if (!isJsonObject(parsed)) {
    throw new Error(`packages/${directory}/package.json is not a JSON object`);
  }
  return parsed;
}

async function manifestField(root: string, directory: string, field: string): Promise<unknown> {
  return (await readManifest(root, directory))[field];
}

async function writeManifestVersion(root: string, directory: string, version: string): Promise<void> {
  const manifest = await readManifest(root, directory);
  await writeFile(join(root, 'packages', directory, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}
