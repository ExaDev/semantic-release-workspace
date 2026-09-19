import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError, UnsupportedDependencyRangeError } from './errors';
import { resumeWorkspaceRelease, type DetachedPackageRelease } from './gate-publish';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { writeDependencyRange } from './manifest';
import { type PublishPluginSpec } from './plugins';
import { readRecordingPluginCalls, writeRecordingPlugin } from './recording-plugin-fixture';
import { releaseWorkspace } from './release';
import { TestTimeoutMs } from './test-timeouts';

/** Matches release.test.ts's own releaseEnv -- see that file for why every recognisable CI service variable is stripped before forcing CI=true. */
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

describe('gatePublish against a real git workspace', () => {
  it('detach tags and pushes every due package without publishing; resume then publishes them, in the same order', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const recordingPlugin = await writeRecordingPlugin(fixture.root);
      const plugins: readonly PublishPluginSpec[] = [
        // npm's own prepare step is what actually writes the bumped version into package.json on disk -- without it, bumpDependents' pnpm-lock.yaml regeneration fails, since it would be asked to resolve a dependency range against a workspace sibling whose manifest was never actually bumped. npmPublish: false keeps its own publish step inert either way.
        ['@semantic-release/npm', { npmPublish: false }],
        ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
        recordingPlugin.modulePath,
      ];

      const detachOutcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins, gatePublish: true });

      expect(detachOutcome.order).toEqual(['@fixture/a', '@fixture/b', '@fixture/c']);
      const detached = detachOutcome.detached;
      expect(detached).toBeDefined();
      const byName = new Map((detached ?? []).map((entry) => [entry.name, entry]));
      expect(byName.get('@fixture/a')?.state?.nextRelease.version).toBe('1.1.0');
      expect(byName.get('@fixture/b')?.state?.nextRelease.version).toBe('1.0.1');
      expect(byName.get('@fixture/c')?.state?.nextRelease.version).toBe('1.0.1');

      // Tagged and pushed for real, on both sides.
      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort();
      expect(localTags).toContain('@fixture/a@1.1.0');
      expect(localTags).toContain('@fixture/b@1.0.1');
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n').filter(Boolean).sort();
      expect(remoteTags).toContain('@fixture/a@1.1.0');

      // The dependency-bump commits already happened during the detach pass itself, not deferred to resume.
      const bumpLog = await git(['log', '--format=%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog).toContain('chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]');

      // Nothing published yet.
      expect((await readRecordingPluginCalls(recordingPlugin)).publish).toEqual([]);
      expect((await readRecordingPluginCalls(recordingPlugin)).success).toEqual([]);

      const resumeOutcome = await resumeWorkspaceRelease({ root: fixture.root, env: releaseEnv(), detached: detached ?? [] });

      expect(resumeOutcome.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
        ['@fixture/a', '1.1.0'],
        ['@fixture/b', '1.0.1'],
        ['@fixture/c', '1.0.1'],
      ]);

      const finalCalls = await readRecordingPluginCalls(recordingPlugin);
      expect(finalCalls.publish).toHaveLength(chainPackages.length);
      expect(finalCalls.success).toHaveLength(chainPackages.length);
      // Published in the same topological order the detach pass tagged them in, not re-derived and not reversed.
      expect(finalCalls.publish.map((call) => call.version)).toEqual(['1.1.0', '1.0.1', '1.0.1']);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('rejects gatePublish combined with commitStrategy "single" before touching git', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const headBefore = await git(['rev-parse', 'HEAD'], { cwd: fixture.root });

      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), gatePublish: true, commitStrategy: 'single' });
      await expect(failure).rejects.toBeInstanceOf(ReleaseConfigurationError);
      await expect(failure).rejects.toThrow(/commitStrategy: "single"/);

      const headAfter = await git(['rev-parse', 'HEAD'], { cwd: fixture.root });
      expect(headAfter).toBe(headBefore);
      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean);
      expect(localTags).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0', '@fixture/c@1.0.0']);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

  it('resumeWorkspaceRelease reports "no release to resume" for a package the detach pass found nothing to release for', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(c): standalone feature', files: { 'packages/c/src/index.js': 'export const c = 2;\n' } },
    ]);
    try {
      const recordingPlugin = await writeRecordingPlugin(fixture.root);
      const plugins: readonly PublishPluginSpec[] = [
        // npm's own prepare step is what actually writes the bumped version into package.json on disk -- without it, bumpDependents' pnpm-lock.yaml regeneration fails, since it would be asked to resolve a dependency range against a workspace sibling whose manifest was never actually bumped. npmPublish: false keeps its own publish step inert either way.
        ['@semantic-release/npm', { npmPublish: false }],
        ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
        recordingPlugin.modulePath,
      ];

      const detachOutcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins, gatePublish: true });
      const detached: readonly DetachedPackageRelease[] = detachOutcome.detached ?? [];
      expect(detached.find((entry) => entry.name === '@fixture/a')?.state).toBeNull();

      const resumeOutcome = await resumeWorkspaceRelease({ root: fixture.root, env: releaseEnv(), detached });
      expect(resumeOutcome.packages.map((pkg) => [pkg.name, pkg.released])).toEqual([
        ['@fixture/a', false],
        ['@fixture/b', false],
        ['@fixture/c', true],
      ]);

      const finalCalls = await readRecordingPluginCalls(recordingPlugin);
      expect(finalCalls.publish).toHaveLength(1);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('refuses to detach a publishable package declaring a workspace: range, before anything is tagged or pushed', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: false, dependencies: { '@fixture/a': 'workspace:^' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), gatePublish: true });
      await expect(failure).rejects.toBeInstanceOf(UnsupportedDependencyRangeError);
      await expect(failure).rejects.toThrow('@fixture/b: "@fixture/a" in dependencies is declared as "workspace:^"');

      expect((await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim()).toBe(headBefore);
      expect((await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort()).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0']);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

  it('refuses to resume a detached release whose package manifest now declares a workspace: range, publishing nothing', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: false, dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const recordingPlugin = await writeRecordingPlugin(fixture.root);
      const plugins: readonly PublishPluginSpec[] = [
        ['@semantic-release/npm', { npmPublish: false }],
        ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
        recordingPlugin.modulePath,
      ];
      const detachOutcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins, gatePublish: true });
      const detached: readonly DetachedPackageRelease[] = detachOutcome.detached ?? [];

      // A state file written by a release of this tool that predates the check, resumed against a manifest that still carries the unresolved range: resume is the last step before `npm publish`, so it checks too.
      await writeDependencyRange(join(fixture.root, 'packages/b/package.json'), 'dependencies', '@fixture/a', 'workspace:^');

      const failure = resumeWorkspaceRelease({ root: fixture.root, env: releaseEnv(), detached });
      await expect(failure).rejects.toBeInstanceOf(UnsupportedDependencyRangeError);
      await expect(failure).rejects.toThrow('@fixture/b: "@fixture/a" in dependencies is declared as "workspace:^"');
      expect((await readRecordingPluginCalls(recordingPlugin)).publish).toEqual([]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('lets a package override the publish plugins: detach tags every package, and resume publishes only through the plugins each package was detached with', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: true, dependencies: { '@fixture/a': '^1.0.0' } },
        { name: '@fixture/c', version: '1.0.0', private: false, dependencies: { '@fixture/b': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const recordingPlugin = await writeRecordingPlugin(fixture.root);
      const overridden: readonly PublishPluginSpec[] = [
        ['@semantic-release/npm', { npmPublish: false }],
        ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
      ];

      const detachOutcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: [...overridden, recordingPlugin.modulePath],
        packagePlugins: { '@fixture/b': overridden },
        gatePublish: true,
      });
      const detached: readonly DetachedPackageRelease[] = detachOutcome.detached ?? [];

      // Every package is tagged and pushed, the overridden one included.
      expect(detached.map((entry) => [entry.name, entry.state?.nextRelease.version])).toEqual([
        ['@fixture/a', '1.1.0'],
        ['@fixture/b', '1.0.1'],
        ['@fixture/c', '1.0.1'],
      ]);
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n');
      expect(remoteTags).toEqual(expect.arrayContaining(['@fixture/a@1.1.0', '@fixture/b@1.0.1', '@fixture/c@1.0.1']));

      // The resume rebuilds each package's pipeline from the state it was detached with, so the override survives into a separate process.
      await resumeWorkspaceRelease({ root: fixture.root, env: releaseEnv(), detached });
      const calls = await readRecordingPluginCalls(recordingPlugin);
      expect(calls.publish.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);
      expect(calls.success.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});
