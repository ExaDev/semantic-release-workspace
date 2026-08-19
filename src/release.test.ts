import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDependencyBumpMessage } from './dependency-bump-commit';
import { DependencyCycleError, UnsupportedDependencyRangeError } from './errors';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { writeDependencyRange } from './manifest';
import { type PublishPluginSpec } from './plugins';
import { releaseWorkspace } from './release';

/**
 * The publish pipeline for these tests is deliberately offline: @semantic-release/npm with npmPublish false still performs the real manifest version bump in prepare, and @semantic-release/git still performs the real release commit, so every part of the orchestrator's sequencing is exercised against real git state (tags, commits, pushes to the fixture's bare remote) without touching the npm registry or GitHub.
 */
const FIXTURE_PLUGINS: readonly PublishPluginSpec[] = [
  ['@semantic-release/npm', { npmPublish: false }],
  ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
];

/**
 * A deterministic environment for the per-package semantic-release runs: every recognisable CI service variable is stripped so env-ci cannot mistake the test runner's own CI (GitHub Actions runs these very tests) for the release run's CI, then CI=true alone is set so semantic-release runs in real mode (env-ci's fallback reads the branch straight from the local git repository).
 */
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

describe('releaseWorkspace against a real git workspace', () => {
  it('releases every package in dependency order with path-scoped commits and cascading dependency bumps', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      // A feat at the workspace root: if the path scoping were broken, this commit would push every package to a minor release, not just a.
      { message: 'feat: workspace-wide readme', files: { 'README.md': '# fixture workspace\n' } },
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      expect(outcome.order).toEqual(['@fixture/a', '@fixture/b', '@fixture/c']);

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      // a: its own feat is a minor; the root-level feat and b/c's scaffolding commits in its range are filtered out (a minor, not a major, proves the filter dropped the other feat).
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor', dependencyBumps: [] });
      // b: nothing of its own changed; the only commit touching it is the orchestrator's bump of @fixture/a, which the default angular preset does not release on its own, so the release is the forced dependency patch.
      expect(byName.get('@fixture/b')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [
          { dependent: '@fixture/b', dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', kind: 'rewritten', field: 'dependencies' },
        ],
      });
      expect(byName.get('@fixture/c')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [
          { dependent: '@fixture/c', dependency: '@fixture/b', version: '1.0.1', range: '^1.0.1', kind: 'rewritten', field: 'dependencies' },
        ],
      });

      // The manifests on disk carry the new ranges and the released versions.
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.1.0');
      await expect(manifestDependency(fixture.root, '@fixture/c', '@fixture/b')).resolves.toBe('^1.0.1');
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
      await expect(manifestVersion(fixture.root, '@fixture/c')).resolves.toBe('1.0.1');

      // Real per-package tags exist locally and on the remote the run pushed to.
      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort();
      expect(localTags).toContain('@fixture/a@1.1.0');
      expect(localTags).toContain('@fixture/b@1.0.1');
      expect(localTags).toContain('@fixture/c@1.0.1');
      const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n').filter(Boolean).sort();
      expect(remoteTags).toContain('@fixture/b@1.0.1');

      // The dependency bumps are real commits carrying [skip ci], and they only touch the dependent's manifest. (--grep is POSIX basic regex, where parentheses are literal characters.)
      const bumpLog = await git(['log', '--name-only', '--format=%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog).toContain('chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]');
      expect(bumpLog).toContain('chore(deps): bump @fixture/b to ^1.0.1 in @fixture/c [skip ci]');
      expect(bumpLog).toContain('packages/b/package.json');
      expect(bumpLog).not.toContain('packages/a/package.json');
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('finds nothing to release on a second run over already-released state', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      const second = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      expect(second.packages.map((pkg) => [pkg.name, pkg.released])).toEqual([
        ['@fixture/a', false],
        ['@fixture/b', false],
        ['@fixture/c', false],
      ]);
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('reports the same cascade in a dry run, including the forced dependency patches, without writing anything', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const headBefore = await git(['rev-parse', 'HEAD'], { cwd: fixture.root });
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [] });

      expect(outcome.packages.map((pkg) => [pkg.name, pkg.version, pkg.type])).toEqual([
        ['@fixture/a', '1.1.0', 'minor'],
        ['@fixture/b', '1.0.1', 'patch'],
        ['@fixture/c', '1.0.1', 'patch'],
      ]);

      const headAfter = await git(['rev-parse', 'HEAD'], { cwd: fixture.root });
      expect(headAfter).toBe(headBefore);
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.0.0');
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('fails loudly on a cyclic dependency graph, naming the loop, instead of picking an arbitrary order', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/x', version: '1.0.0', dependencies: { '@fixture/y': '^1.0.0' } },
        { name: '@fixture/y', version: '1.0.0', dependencies: { '@fixture/x': '^1.0.0' } },
      ],
      [],
    );
    try {
      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      await expect(failure).rejects.toBeInstanceOf(DependencyCycleError);
      await expect(failure).rejects.toThrow(
        /cycle: @fixture\/x -> @fixture\/y -> @fixture\/x|cycle: @fixture\/y -> @fixture\/x -> @fixture\/y/,
      );
      // Nothing was committed while failing: the log still holds only the fixture's own scaffolding.
      const log = await git(['log', '--oneline', 'main'], { cwd: fixture.root });
      expect(log.split('\n').filter(Boolean)).toHaveLength(3);
    } finally {
      await fixture.remove();
    }
  }, 60_000);

  it('cascades through workspace: ranges pnpm resolves at publish time, releasing dependents without editing or committing their manifests', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': 'workspace:^' } },
        { name: '@fixture/c', version: '1.0.0', dependencies: { '@fixture/b': 'workspace:^' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
      // The whole point of the resolved-at-publish kind: no manifest edit happens, so nothing in b's own directory changed, and the release is driven purely by the recorded bump -- the published range still changes because pnpm substitutes it at pack time.
      expect(byName.get('@fixture/b')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [
          { dependent: '@fixture/b', dependency: '@fixture/a', version: '1.1.0', range: 'workspace:^', kind: 'resolved-at-publish' },
        ],
      });
      expect(byName.get('@fixture/c')).toMatchObject({
        released: true,
        version: '1.0.1',
        type: 'patch',
        dependencyBumps: [
          { dependent: '@fixture/c', dependency: '@fixture/b', version: '1.0.1', range: 'workspace:^', kind: 'resolved-at-publish' },
        ],
      });

      // The ranges are left exactly as written, while the released versions are still written through.
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('workspace:^');
      await expect(manifestDependency(fixture.root, '@fixture/c', '@fixture/b')).resolves.toBe('workspace:^');
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');

      // No bump commits at all: there was no manifest change to commit.
      const bumpLog = await git(['log', '--format=%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog.trim()).toBe('');
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('releases only the package with changes; the packages upstream of it release nothing', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(c): standalone feature', files: { 'packages/c/src/index.js': 'export const c = 2;\n' } },
    ]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      expect(outcome.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
        ['@fixture/a', undefined],
        ['@fixture/b', undefined],
        ['@fixture/c', '1.1.0'],
      ]);
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('releases every package correctly when the workspace is nested below the git repository toplevel', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
      { workspaceSubdirectory: 'monorepo' },
    );
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      // Before the git-toplevel fix, `relativeDirectory` (workspace-root-relative) was compared against `git log` output (repository-root-relative), which never matched once the workspace sat below the repository root -- every package silently released nothing.
      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1', type: 'patch' });
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('releases a package whose directory name contains a non-ASCII character', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/plain', version: '1.0.0' },
        // A directory distinct from the (necessarily plain-ASCII) npm package name -- pnpm only needs the glob to match the directory, not the directory to match the name -- so this exercises the C-quoting fix without needing an npm name real npm would reject.
        { name: '@fixture/cafe', version: '1.0.0', directory: 'café' },
      ],
      [
        { message: 'feat(plain): second feature', files: { 'packages/plain/src/index.js': 'export const plain = 2;\n' } },
        { message: 'feat(cafe): second feature', files: { 'packages/café/src/index.js': 'export const cafe = 2;\n' } },
      ],
    );
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      // Before the core.quotePath fix, git C-quoted the café path, the prefix comparison never matched, and this package silently released nothing while its plain-ASCII sibling released normally.
      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/plain')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
      expect(byName.get('@fixture/cafe')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('recovers the forced-patch decision from a bump commit already in history, as if a previous run stopped between the dependency release and the dependent turn', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      // Reproduce exactly the state a crash between `a`'s release and `b`'s turn leaves: `a` already released, tagged, with its version written through...
      await writeManifestVersion(fixture.root, '@fixture/a', '1.1.0');
      await git(['add', '--', 'packages/a/package.json'], { cwd: fixture.root });
      await git(['commit', '-m', 'chore(release): @fixture/a@1.1.0 [skip ci]'], { cwd: fixture.root });
      await git(['tag', '@fixture/a@1.1.0'], { cwd: fixture.root });

      // ...and `b`'s manifest already bumped, committed, and pushed -- the exact commit `bumpDependents` makes -- with no in-memory record of it anywhere, because this is a brand-new process that never ran the first half of this release.
      await writeDependencyRange(join(fixture.root, 'packages/b/package.json'), 'dependencies', '@fixture/a', '^1.1.0');
      const message = formatDependencyBumpMessage({ dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', dependent: '@fixture/b' });
      await git(['add', '--', 'packages/b/package.json'], { cwd: fixture.root });
      await git(['commit', '-m', message], { cwd: fixture.root });
      await git(['push', 'origin', 'main', '--tags'], { cwd: fixture.root });

      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      // `a` has no releasable commits after the tag this test placed manually -- it must not release again.
      expect(byName.get('@fixture/a')).toMatchObject({ released: false });
      // `b` has no commit of its own beyond the bump commit, which the standard analyzer alone releases nothing for; recovering the bump from history is the only way this releases at all.
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1', type: 'patch' });
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
    } finally {
      await fixture.remove();
    }
  }, 240_000);

  it('rejects an unsupported dependency range before anything releases, not only once the dependency it names has already been published', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '>=1.0.0 <2.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      await expect(failure).rejects.toBeInstanceOf(UnsupportedDependencyRangeError);

      // Nothing published: the run fails before the loop starts, so `a` carries no new tag and no release commit, and the remote holds only the fixture's own scaffolding.
      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort();
      expect(localTags).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0']);
      await expect(manifestVersion(fixture.root, '@fixture/a')).resolves.toBe('1.0.0');
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

/** Rewrites a fixture package's own version on disk, for tests that need to hand-construct a git history state (a prior release already tagged) rather than have `releaseWorkspace` produce it. */
async function writeManifestVersion(root: string, packageName: string, version: string): Promise<void> {
  const path = join(root, 'packages', packageName.slice(packageName.indexOf('/') + 1), 'package.json');
  const manifest = await readManifest(root, packageName);
  await writeFile(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, 'utf8');
}
