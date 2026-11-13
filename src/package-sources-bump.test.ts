import { describe, expect, it } from 'vitest';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { DEFAULT_PUBLISH_PLUGINS, type PublishPluginSpec } from './plugins';
import { releaseWorkspace, type ReleaseWorkspaceOptions } from './release';
import { RELEASE_COMMIT_TRAILER } from './release-commit';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

/** Offline publish pipeline, as in `release.test.ts`: `@semantic-release/npm` writes the version without publishing, `@semantic-release/git` makes the real release commit. */
const PLUGINS: readonly PublishPluginSpec[] = [
  ['@semantic-release/npm', { npmPublish: false }],
  // The default pipeline's release commit message, trailer included.
  ['@semantic-release/git', { assets: ['package.json'], message: `chore(release): \${nextRelease.gitTag} [skip ci]\n\n${RELEASE_COMMIT_TRAILER}` }],
];

const NPM_ONLY: PublishPluginSpec = ['@semantic-release/npm', { npmPublish: false }];

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

describe('packageSources against release commits', () => {
  /** Independent packages, so the only commits a package can see from its sibling are the sibling's feature and its release commit. `a` runs first, so `b`'s release commit lands after `a`'s tag. */
  // `b` is scaffolded first so `a`'s first tag follows `b`'s scaffold commit, which also writes `packages/b/package.json`.
  const independent: readonly FixturePackage[] = [
    { name: '@fixture/b', version: '1.0.0', private: false },
    { name: '@fixture/a', version: '1.0.0', private: false },
  ];

  /** A project that maps `chore` to a patch release, as the consumer of this option does. */
  const choreIsPatch = { releaseRules: [{ type: 'chore', release: 'patch' }] };

  /**
   * `a` lists only `packages/b/package.json`, which `b`'s feature commit does not touch and `b`'s release commit does (it writes the version). So the first run releases `b` alone, and `a`'s range in the second run still contains that release commit, because `a` was not part of the release that tagged it. With `chore` mapped to a patch release, `a` releases then unless the release commit is recognised as the orchestrator's own.
   */
  async function secondRunAfterSiblingRelease(commitStrategy: 'per-package' | 'single'): Promise<readonly string[]> {
    const fixture = await createWorkspaceFixture(independent, [{ message: 'feat(b): add a feature', files: { 'packages/b/src/index.js': 'export const feature = 1;\n' } }]);
    try {
      const plugins = commitStrategy === 'single' ? [NPM_ONLY] : PLUGINS;
      const options = { root: fixture.root, env: releaseEnv(), plugins, commitStrategy, analyzeCommits: choreIsPatch, packageSources: { '@fixture/a': ['packages/b/package.json'] } };
      const first = await releaseWorkspace(options);
      expect(first.packages.filter((pkg) => pkg.released).map((pkg) => pkg.name)).toEqual(['@fixture/b']);
      const second = await releaseWorkspace(options);
      return second.packages.filter((pkg) => pkg.released).map((pkg) => pkg.name);
    } finally {
      await fixture.remove();
    }
  }

  it('does not release a package again because a sibling its sources cover wrote a release commit', async () => {
    expect(await secondRunAfterSiblingRelease('per-package')).toEqual([]);
  }, TestTimeoutMs.Long);

  it('does not release a package again under commitStrategy single', async () => {
    expect(await secondRunAfterSiblingRelease('single')).toEqual([]);
  }, TestTimeoutMs.Long);
});

describe('the default publish pipeline', () => {
  it('writes release commits that carry the release-commit trailer', () => {
    const gitPlugin = DEFAULT_PUBLISH_PLUGINS.find((spec) => Array.isArray(spec) && spec[0] === '@semantic-release/git');
    expect(JSON.stringify(gitPlugin)).toContain(RELEASE_COMMIT_TRAILER);
  });
});
