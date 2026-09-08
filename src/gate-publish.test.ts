import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError } from './errors';
import { resumeWorkspaceRelease, type DetachedPackageRelease } from './gate-publish';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject, isUnknownArray } from './json';
import { type PublishPluginSpec } from './plugins';
import { releaseWorkspace } from './release';

interface RecordingPlugin {
  readonly modulePath: string;
  readonly callsFile: string;
}

/**
 * A real, resolvable ESM plugin module recording every `publish`/`success` call -- not a mock. `PublishPluginSpec` only accepts a module name or file path (not an inline object the way semantic-release's own engine supports, see @exadev/release-gate's test fixtures for that alternative), so this writes a genuine file `resolvePluginModule` resolves via `require.resolve` on its absolute path. Calls are recorded to a plain JSON file on disk, synchronously, rather than an in-memory module-level array: semantic-release's own plugin loader (`await import(...)` deep inside its own compiled internals) and this test file's own re-import of the same path are two separate module registries under vitest's vite-node runtime, so a shared in-memory array written by one is invisible to the other -- confirmed directly, the array read back was always empty despite the real calls genuinely happening. A file on disk has no such ambiguity, and incidentally matches this feature's own real-world shape better: a resume can genuinely run in a different process from the one that recorded a detach.
 */
async function writeRecordingPlugin(dir: string): Promise<RecordingPlugin> {
  const modulePath = join(dir, 'recording-plugin.js');
  const callsFile = join(dir, 'recording-plugin-calls.json');
  await writeFile(callsFile, JSON.stringify({ publish: [], success: [] }));
  await writeFile(
    modulePath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const CALLS_FILE = ${JSON.stringify(callsFile)};`,
      'function record(step, entry) {',
      '  const calls = JSON.parse(readFileSync(CALLS_FILE, "utf8"));',
      '  calls[step].push(entry);',
      '  writeFileSync(CALLS_FILE, JSON.stringify(calls));',
      '}',
      'export async function publish(pluginConfig, context) {',
      '  record("publish", { name: context.nextRelease.gitTag, version: context.nextRelease.version });',
      '  return { name: `recorded-${context.nextRelease.version}` };',
      '}',
      'export async function success(pluginConfig, context) {',
      '  record("success", { version: context.nextRelease.version });',
      '}',
      '',
    ].join('\n'),
  );
  return { modulePath, callsFile };
}

interface RecordedCall {
  readonly version: string;
}

async function readRecordingPluginCalls(plugin: RecordingPlugin): Promise<{ readonly publish: readonly RecordedCall[]; readonly success: readonly RecordedCall[] }> {
  const parsed: unknown = JSON.parse(await readFile(plugin.callsFile, 'utf8'));
  if (!isJsonObject(parsed) || !isUnknownArray(parsed.publish) || !isUnknownArray(parsed.success)) {
    throw new Error(`${plugin.callsFile} does not contain a valid calls object.`);
  }
  return { publish: parsed.publish as RecordedCall[], success: parsed.success as RecordedCall[] };
}

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
      expect(finalCalls.publish).toHaveLength(3);
      expect(finalCalls.success).toHaveLength(3);
      // Published in the same topological order the detach pass tagged them in, not re-derived and not reversed.
      expect(finalCalls.publish.map((call) => call.version)).toEqual(['1.1.0', '1.0.1', '1.0.1']);
    } finally {
      await fixture.remove();
    }
  }, 240_000);

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
  }, 60_000);

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
  }, 240_000);
});
