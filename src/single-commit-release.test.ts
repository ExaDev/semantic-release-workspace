import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError, UnsupportedDependencyRangeError } from './errors';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { type PublishPluginSpec } from './plugins';
import { createRecordingPlugin, readRecordingPluginCalls } from './recording-plugin-fixture';
import { releaseWorkspace } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

/**
 * `@semantic-release/changelog` and `@semantic-release/npm` (with npmPublish false) are enough to exercise the real "prepare" path (version bump + changelog write) and the real "publish"/"verifyConditions" path (both skip real registry/network calls when npmPublish is false, exactly like release.test.ts's own FIXTURE_PLUGINS) without ever touching the npm registry or GitHub. `@semantic-release/git` is deliberately absent: commitStrategy "single" rejects it outright (see the dedicated test below).
 */
const SINGLE_FIXTURE_PLUGINS: readonly PublishPluginSpec[] = ['@semantic-release/changelog', ['@semantic-release/npm', { npmPublish: false }]];

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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

      // Nothing published: the run fails before analysis even starts -- one "scaffold workspace" commit plus one per chainPackages entry (see createWorkspaceFixture).
      const log = await git(['log', '--oneline', 'main'], { cwd: fixture.root });
      expect(log.split('\n').filter(Boolean)).toHaveLength(chainPackages.length + 1);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

  it('refuses to release a publishable package declaring a workspace: range, before anything is written, committed, or tagged', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: false, dependencies: { '@fixture/a': 'workspace:^' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: SINGLE_FIXTURE_PLUGINS, commitStrategy: 'single' });
      await expect(failure).rejects.toBeInstanceOf(UnsupportedDependencyRangeError);
      await expect(failure).rejects.toThrow('@fixture/b: "@fixture/a" in dependencies is declared as "workspace:^"');

      expect((await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim()).toBe(headBefore);
      expect((await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort()).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0']);
      await expect(manifestVersion(fixture.root, '@fixture/a')).resolves.toBe('1.0.0');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

  it('lets a package override the publish plugins: a private package without the recording plugin still gets its tag, version bump and dependency cascade, and publishes nothing', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: true, dependencies: { '@fixture/a': '^1.0.0' } },
        { name: '@fixture/c', version: '1.0.0', private: false, dependencies: { '@fixture/b': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    // Stands in for @semantic-release/github, which needs network access and a token. Kept outside the fixture repository: this mode refuses to start on a dirty working tree.
    const recording = await createRecordingPlugin();
    try {
      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: [...SINGLE_FIXTURE_PLUGINS, recording.modulePath],
        packagePlugins: { '@fixture/b': SINGLE_FIXTURE_PLUGINS },
        commitStrategy: 'single',
      });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0' });
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1' });
      expect(byName.get('@fixture/c')).toMatchObject({ released: true, version: '1.0.1' });

      const calls = await readRecordingPluginCalls(recording);
      expect(calls.publish.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);
      expect(calls.success.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);

      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
      await expect(manifestDependency(fixture.root, '@fixture/c', '@fixture/b')).resolves.toBe('^1.0.1');
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n');
      expect(remoteTags).toEqual(expect.arrayContaining(['@fixture/a@1.1.0', '@fixture/b@1.0.1', '@fixture/c@1.0.1']));
    } finally {
      await recording.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
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

/**
 * Installs an executable hook, pinning `core.hooksPath` to the repository's own hooks directory first so a machine-wide `core.hooksPath` (this tool's own development machines set one) cannot shadow it and silently turn these tests into no-ops that pass for the wrong reason.
 */
async function installHook(gitRoot: string, name: string, script: string): Promise<void> {
  await git(['config', 'core.hooksPath', '.git/hooks'], { cwd: gitRoot });
  await writeFile(join(gitRoot, '.git', 'hooks', name), script, { mode: 0o755 });
}

/**
 * A `pre-push` hook that lands a real `feat(a)` commit on the real bare remote from a separate clone, for the first `sabotagePushes` pushes only, then lets the push it is hooked into proceed.
 *
 * This is what makes the rejection genuine rather than mocked: git runs this hook after the orchestrator has finished analysing, preparing, committing and tagging, and immediately before it negotiates refs with the remote, so the remote really has moved by the time our refs are offered and the remote itself really rejects them as non-fast-forward. semantic-release's own `verifyAuth` probe cannot trip it, because that probe passes `--no-verify` (see its `lib/git.js`), so every hook invocation counted here is a real orchestrator push.
 */
async function installCompetingPusher(gitRoot: string, remoteUrl: string, counterFile: string, sabotagePushes: number): Promise<void> {
  await installHook(
    gitRoot,
    'pre-push',
    [
      '#!/bin/sh',
      'set -e',
      `COUNTER=${JSON.stringify(counterFile)}`,
      'echo push >> "$COUNTER"',
      'COUNT=$(wc -l < "$COUNTER" | tr -d " ")',
      `if [ "$COUNT" -gt ${String(sabotagePushes)} ]; then exit 0; fi`,
      'WORK=$(mktemp -d)',
      `git clone --quiet ${JSON.stringify(remoteUrl)} "$WORK/clone"`,
      'cd "$WORK/clone"',
      'git config user.name "Competing Pusher"',
      'git config user.email "competing@example.com"',
      'mkdir -p packages/a/src',
      'printf "export const competing = %s;\\n" "$COUNT" > "packages/a/src/competing-$COUNT.js"',
      'git add -- "packages/a/src/competing-$COUNT.js"',
      'git commit --quiet -m "feat(a): competing feature landed mid-run"',
      'git push --quiet origin HEAD:main',
      'rm -rf "$WORK"',
      'exit 0',
      '',
    ].join('\n'),
  );
}

async function countPushes(counterFile: string): Promise<number> {
  const contents = await readFile(counterFile, 'utf8').catch(() => '');
  return contents.split('\n').filter((line) => line !== '').length;
}

async function remoteTagNames(remote: string): Promise<readonly string[]> {
  const output = await git(['ls-remote', '--tags', remote], { cwd: remote });
  return output
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter((tag): tag is string => tag !== undefined && !tag.endsWith('^{}'))
    .sort();
}

describe('releaseWorkspace with commitStrategy "single" when the branch moves under the run', () => {
  const retryPackages: readonly FixturePackage[] = [{ name: '@fixture/a', version: '1.0.0' }];

  it('recomputes the release against the new tip and publishes only what actually landed', async () => {
    const fixture = await createWorkspaceFixture(retryPackages, [{ message: 'fix(a): a patch worth releasing', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }]);
    const plugin = await createRecordingPlugin();
    const counter = join(fixture.root, '..', 'pushes.log');
    try {
      await installCompetingPusher(fixture.root, pathToFileURL(fixture.remote).href, counter, 1);

      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: [...SINGLE_FIXTURE_PLUGINS, plugin.modulePath],
        commitStrategy: 'single',
      });

      // The first attempt saw only `fix(a)` and planned 1.0.1. The competing `feat(a)` landed before those refs reached the remote, so the surviving release must be the minor that accounts for it, which is the proof that the retry recomputed rather than replayed.
      expect(outcome.packages.find((pkg) => pkg.name === '@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });

      const tags = await remoteTagNames(fixture.remote);
      expect(tags).toContain('@fixture/a@1.1.0');
      expect(tags).not.toContain('@fixture/a@1.0.1');

      const calls = await readRecordingPluginCalls(plugin);
      expect(calls.publish).toEqual([{ name: '@fixture/a@1.1.0', version: '1.1.0' }]);
      expect(await countPushes(counter)).toBe(2);
    } finally {
      await plugin.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('gives up after the configured number of attempts, having published nothing and left no tag behind', async () => {
    const fixture = await createWorkspaceFixture(retryPackages, [{ message: 'fix(a): a patch worth releasing', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }]);
    const plugin = await createRecordingPlugin();
    const counter = join(fixture.root, '..', 'pushes.log');
    const tagsBefore = await remoteTagNames(fixture.remote);
    try {
      await installCompetingPusher(fixture.root, pathToFileURL(fixture.remote).href, counter, Number.MAX_SAFE_INTEGER);

      await expect(
        releaseWorkspace({
          root: fixture.root,
          env: releaseEnv(),
          plugins: [...SINGLE_FIXTURE_PLUGINS, plugin.modulePath],
          commitStrategy: 'single',
          pushAttempts: 2,
        }),
      ).rejects.toThrow(/2 attempt/);

      expect(await remoteTagNames(fixture.remote)).toEqual(tagsBefore);
      expect((await readRecordingPluginCalls(plugin)).publish).toEqual([]);
      expect(await countPushes(counter)).toBe(2);
    } finally {
      await plugin.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('does not retry a rejection that is not a race, even though the remote rejected the refs', async () => {
    const fixture = await createWorkspaceFixture(retryPackages, [{ message: 'fix(a): a patch worth releasing', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }]);
    const plugin = await createRecordingPlugin();
    const counter = join(fixture.root, '..', 'pushes.log');
    try {
      // The remote refuses the push outright without moving. A retry could never succeed, so the run must fail on the first rejection rather than burning every attempt on it. The bare remote gets its own `core.hooksPath` pin for the same reason the working repository does.
      await git(['config', 'core.hooksPath', 'hooks'], { cwd: fixture.remote });
      await writeFile(join(fixture.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "declined by policy" >&2\nexit 1\n', { mode: 0o755 });
      await installHook(fixture.root, 'pre-push', `#!/bin/sh\necho push >> ${JSON.stringify(counter)}\nexit 0\n`);

      await expect(
        releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: [...SINGLE_FIXTURE_PLUGINS, plugin.modulePath], commitStrategy: 'single' }),
      ).rejects.toThrow(/declined by policy/);

      expect(await countPushes(counter)).toBe(1);
      expect((await readRecordingPluginCalls(plugin)).publish).toEqual([]);
    } finally {
      await plugin.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});
