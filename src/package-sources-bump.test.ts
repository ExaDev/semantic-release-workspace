import { describe, expect, it } from 'vitest';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { type PublishPluginSpec } from './plugins';
import { releaseWorkspace, type ReleaseWorkspaceOptions } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

/** Offline publish pipeline, as in `release.test.ts`: `@semantic-release/npm` writes the version without publishing, `@semantic-release/git` makes the real release commit. */
const PLUGINS: readonly PublishPluginSpec[] = [
  ['@semantic-release/npm', { npmPublish: false }],
  ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
];

/** `app` depends on `wasm`, so a `wasm` release makes the orchestrator write a bump commit in `app`'s directory and the root lockfile. */
const packages: readonly FixturePackage[] = [
  { name: '@fixture/wasm', version: '1.0.0', private: false },
  { name: '@fixture/app', version: '1.0.0', private: false, dependencies: { '@fixture/wasm': '^1.0.0' } },
];

/** Releases `wasm` for real, then runs again and reports which packages the second run released. */
async function secondRunReleases(packageSources: ReleaseWorkspaceOptions['packageSources']): Promise<readonly string[]> {
  const fixture = await createWorkspaceFixture(packages, [{ message: 'feat(wasm): add a feature', files: { 'packages/wasm/src/index.js': 'export const feature = 1;\n' } }], { pnpmLockfile: true });
  try {
    const first = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: PLUGINS, packageSources });
    expect(first.packages.filter((pkg) => pkg.released).map((pkg) => pkg.name)).toEqual(['@fixture/wasm', '@fixture/app']);
    expect((await git(['log', '--format=%s', '--grep=^chore(deps):'], { cwd: fixture.root })).trim().split('\n')).toHaveLength(1);
    const second = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: PLUGINS, packageSources });
    return second.packages.filter((pkg) => pkg.released).map((pkg) => pkg.name);
  } finally {
    await fixture.remove();
  }
}

describe('packageSources against the orchestrator\'s own commits', () => {
  it('does not release a package again because its source path covers a dependent whose manifest a bump rewrote', async () => {
    expect(await secondRunReleases({ '@fixture/wasm': ['packages/app'] })).toEqual([]);
  }, TestTimeoutMs.Long);

  it('does not release a package because its source path covers the lockfile every bump rewrites', async () => {
    expect(await secondRunReleases({ '@fixture/wasm': ['pnpm-lock.yaml'] })).toEqual([]);
  }, TestTimeoutMs.Long);

  it('does not release a package because its source glob covers every package directory', async () => {
    expect(await secondRunReleases({ '@fixture/wasm': ['packages/*'] })).toEqual([]);
  }, TestTimeoutMs.Long);
});
