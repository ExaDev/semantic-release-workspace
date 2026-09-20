import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDependencyBumpMessage } from './dependency-bump-commit';
import { DependencyCycleError, ReleaseConfigurationError, UnsupportedDependencyRangeError } from './errors';
import { git } from './git';
import { type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { writeDependencyRange } from './manifest';
import { type PublishPluginSpec } from './plugins';
import { createRecordingPlugin, readRecordingPluginCalls } from './recording-plugin-fixture';
import { releaseWorkspace } from './release';
import { TestTimeoutMs } from './test-timeouts';

/**
 * The publish pipeline for these tests is deliberately offline: `@semantic-release/npm` with npmPublish false still performs the real manifest version bump in prepare, and `@semantic-release/git` still performs the real release commit, so every part of the orchestrator's sequencing is exercised against real git state (tags, commits, pushes to the fixture's bare remote) without touching the npm registry or GitHub.
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
  it('supports a custom tagFormat whose tags are usable as GitHub Actions refs', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ], { tagFormat: '${name}-v${version}' });
    try {
      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: FIXTURE_PLUGINS,
        tagFormat: '${name}-v${version}',
      });

      // The forced dependency patch releases cascaded with the custom template too.
      expect(outcome.packages.every((pkg) => pkg.released)).toBe(true);

      const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean);
      // The scoped fixture names contain '@', which the custom template exercises verbatim.
      expect(localTags).toContain('@fixture/a-v1.1.0');
      expect(localTags).toContain('@fixture/b-v1.0.1');
      expect(localTags).not.toContain('@fixture/a@1.1.0');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('rejects a tagFormat without the version placeholder before anything releases', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, []);
    try {
      await expect(
        releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, tagFormat: '${name}' }),
      ).rejects.toThrow(/must contain '\$\{version\}'/);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

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
  }, TestTimeoutMs.Long);

  it('behaves identically whether commitStrategy is omitted or explicitly set to "per-package"', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, commitStrategy: 'per-package' });

      // Same shape and versions as the very first test's implicit-default run: one commit per release plus one per dependency bump, not the "single" strategy's one combined commit.
      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1', type: 'patch' });
      expect(byName.get('@fixture/c')).toMatchObject({ released: true, version: '1.0.1', type: 'patch' });

      // Four release/bump commits landed on top of the fixture's own scaffolding (a's release, b's bump, b's release, c's bump, c's release -- five, not one), each pushed separately, exactly as when commitStrategy is left unset.
      const bumpLog = await git(['log', '--format=%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog.split('\n').filter(Boolean)).toHaveLength(2);
      const releaseLog = await git(['log', '--format=%s', '--grep=^chore(release):', 'main'], { cwd: fixture.root });
      expect(releaseLog.split('\n').filter(Boolean)).toHaveLength(chainPackages.length);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

  it('fails loudly on a cyclic dependency graph, naming the loop, instead of picking an arbitrary order', async () => {
    const cyclePackages: readonly FixturePackage[] = [
      { name: '@fixture/x', version: '1.0.0', dependencies: { '@fixture/y': '^1.0.0' } },
      { name: '@fixture/y', version: '1.0.0', dependencies: { '@fixture/x': '^1.0.0' } },
    ];
    const fixture = await createWorkspaceFixture(cyclePackages, []);
    try {
      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
      await expect(failure).rejects.toBeInstanceOf(DependencyCycleError);
      await expect(failure).rejects.toThrow(
        /cycle: @fixture\/x -> @fixture\/y -> @fixture\/x|cycle: @fixture\/y -> @fixture\/x -> @fixture\/y/,
      );
      // Nothing was committed while failing: the log still holds only the fixture's own scaffolding -- one "scaffold workspace" commit plus one per package (see createWorkspaceFixture).
      const log = await git(['log', '--oneline', 'main'], { cwd: fixture.root });
      expect(log.split('\n').filter(Boolean)).toHaveLength(cyclePackages.length + 1);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

  it('cascades through bare workspace: ranges in private packages, releasing dependents without editing or committing their manifests', async () => {
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
      // The whole point of the resolved-at-publish kind: the range names no version, so no manifest edit happens and nothing in b's own directory changed; the release is driven purely by the recorded bump.
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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

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
  }, TestTimeoutMs.Long);

  it('regenerates pnpm-lock.yaml alongside a dependency-range bump, so the two never land out of sync', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
      { pnpmLockfile: true },
    );
    try {
      await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      // The bump commit must carry the regenerated lockfile alongside the manifest it rewrote -- committing only the manifest is exactly the bug: `pnpm install --frozen-lockfile` then rejects the resulting tree because the lockfile still names the old specifier.
      const bumpLog = await git(['log', '--name-only', '--format=%H%n%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog).toContain('chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]');
      expect(bumpLog).toContain('pnpm-lock.yaml');

      const lockfile = await readFile(join(fixture.root, 'pnpm-lock.yaml'), 'utf8');
      const bImporter = lockfile.slice(lockfile.indexOf('packages/b:'));
      expect(bImporter).toMatch(/specifier:\s*\^1\.1\.0/);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('keeps the workspace: prefix when it rewrites an anchored workspace: range in a private package, committing the rewritten range', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': 'workspace:^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/b')).toMatchObject({
        released: true,
        dependencyBumps: [{ dependent: '@fixture/b', dependency: '@fixture/a', version: '1.1.0', range: 'workspace:^1.1.0', kind: 'rewritten' }],
      });

      // The prefix survives the rewrite, so a publishable package declaring this form would ship `workspace:^1.1.0` verbatim through npm publish -- which is why publishable packages are rejected for it (see the tests below).
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('workspace:^1.1.0');
      const bumpLog = await git(['log', '--format=%s', '--grep=^chore(deps):', 'main'], { cwd: fixture.root });
      expect(bumpLog).toContain('chore(deps): bump @fixture/a to workspace:^1.1.0 in @fixture/b [skip ci]');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it.each(['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.0.0'])(
    'refuses to release a publishable package declaring %s on a sibling, before anything is tagged, committed, or pushed',
    async (specifier) => {
      const fixture = await createWorkspaceFixture(
        [
          { name: '@fixture/a', version: '1.0.0', private: false },
          { name: '@fixture/b', version: '1.0.0', private: false, dependencies: { '@fixture/a': specifier } },
        ],
        [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
      );
      try {
        const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

        const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });
        await expect(failure).rejects.toBeInstanceOf(UnsupportedDependencyRangeError);
        await expect(failure).rejects.toThrow(`@fixture/b: "@fixture/a" in dependencies is declared as "${specifier}"`);

        // `a` would have released first had the check not run up front: nothing is tagged, committed, or pushed.
        expect((await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim()).toBe(headBefore);
        const localTags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort();
        expect(localTags).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0']);
        const remoteTags = (await git(['tag', '--list'], { cwd: fixture.remote })).split('\n').filter(Boolean).sort();
        expect(remoteTags).toEqual(localTags);
        await expect(manifestVersion(fixture.root, '@fixture/a')).resolves.toBe('1.0.0');
      } finally {
        await fixture.remove();
      }
    },
    TestTimeoutMs.Medium,
  );

  it('still releases publishable packages that declare concrete ranges, and accepts workspace: only in their devDependencies', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: false, dependencies: { '@fixture/a': '^1.0.0' } },
        { name: '@fixture/c', version: '1.0.0', private: false, devDependencies: { '@fixture/a': 'workspace:*' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0' });
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1' });
      expect(byName.get('@fixture/c')).toMatchObject({ released: true, version: '1.0.1' });
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.1.0');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('lets a package override the publish plugins: a private package without the recording plugin still gets its tag, version bump and dependency cascade, and publishes nothing', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: true, dependencies: { '@fixture/a': '^1.0.0' } },
        { name: '@fixture/c', version: '1.0.0', private: false, dependencies: { '@fixture/b': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    // Stands in for @semantic-release/github, which needs network access and a token: a plugin that records every publish, so the test can see exactly which packages the workspace-wide list reached.
    const recording = await createRecordingPlugin();
    try {
      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: [...FIXTURE_PLUGINS, recording.modulePath],
        packagePlugins: { '@fixture/b': FIXTURE_PLUGINS },
      });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0' });
      expect(byName.get('@fixture/b')).toMatchObject({
        released: true,
        version: '1.0.1',
        dependencyBumps: [{ dependent: '@fixture/b', dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', kind: 'rewritten' }],
      });
      expect(byName.get('@fixture/c')).toMatchObject({
        released: true,
        version: '1.0.1',
        dependencyBumps: [{ dependent: '@fixture/c', dependency: '@fixture/b', version: '1.0.1', range: '^1.0.1', kind: 'rewritten' }],
      });

      // The recorded step ran for the packages on the workspace-wide list and never for the overridden one.
      const calls = await readRecordingPluginCalls(recording);
      expect(calls.publish.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);
      expect(calls.success.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/c@1.0.1']);

      // The overridden package kept everything the release itself provides: its version, its tag on both sides, and the cascade through to its dependent.
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
      await expect(manifestDependency(fixture.root, '@fixture/c', '@fixture/b')).resolves.toBe('^1.0.1');
      expect((await git(['tag', '--list'], { cwd: fixture.root })).split('\n')).toContain('@fixture/b@1.0.1');
      expect((await git(['tag', '--list'], { cwd: fixture.remote })).split('\n')).toContain('@fixture/b@1.0.1');
    } finally {
      await recording.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('keeps the GitHub Release plugin off a private package without being told to, and keeps every other plugin on it', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0', private: false },
        { name: '@fixture/b', version: '1.0.0', private: true, dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    const recording = await createRecordingPlugin();
    try {
      // The real @semantic-release/github, not a stand-in: it is the plugin the private-package rule names, and its verifyConditions needs a token and a GitHub repository, neither of which this fixture or `releaseEnv` provides. The private package releasing at all is therefore evidence the plugin never ran for it. The public package reaches it through an override that leaves it off, because a fixture run that did reach it would fail.
      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: releaseEnv(),
        plugins: [...FIXTURE_PLUGINS, '@semantic-release/github', recording.modulePath],
        packagePlugins: { '@fixture/a': [...FIXTURE_PLUGINS, recording.modulePath] },
      });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0' });
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.0.1' });

      // Only @semantic-release/github was dropped from the private package's list: the recording plugin sat beside it on the same workspace-wide list and still ran.
      const calls = await readRecordingPluginCalls(recording);
      expect(calls.publish.map((call) => call.name)).toEqual(['@fixture/a@1.1.0', '@fixture/b@1.0.1']);

      // And the release itself is intact: version bump, tag pushed to the remote, dependency range rewritten.
      await expect(manifestVersion(fixture.root, '@fixture/b')).resolves.toBe('1.0.1');
      await expect(manifestDependency(fixture.root, '@fixture/b', '@fixture/a')).resolves.toBe('^1.1.0');
      expect((await git(['tag', '--list'], { cwd: fixture.remote })).split('\n')).toContain('@fixture/b@1.0.1');
    } finally {
      await recording.remove();
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('rejects a per-package plugin override naming a package that is not in the workspace, before anything releases', async () => {
    const fixture = await createWorkspaceFixture(chainPackages, [
      { message: 'feat(a): second feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ]);
    try {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim();

      const failure = releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, packagePlugins: { '@fixture/typo': FIXTURE_PLUGINS } });
      await expect(failure).rejects.toBeInstanceOf(ReleaseConfigurationError);
      await expect(failure).rejects.toThrow('"@fixture/typo"');

      expect((await git(['rev-parse', 'HEAD'], { cwd: fixture.root })).trim()).toBe(headBefore);
      expect((await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean).sort()).toEqual(['@fixture/a@1.0.0', '@fixture/b@1.0.0', '@fixture/c@1.0.0']);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Medium);

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
  }, TestTimeoutMs.Medium);
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

/**
 * A `post-receive` hook on the bare remote that lands a real `feat(b)` commit on it immediately after the Nth push is accepted, then lets everything carry on.
 *
 * It has to be `post-receive` on the remote rather than `pre-push` on the working repository to reach the case this test is about. `commitStrategy: 'per-package'` finishes a package with the orchestrator's own dependency-bump push, and the next package's first contact with the remote is semantic-release's `verifyAuth` probe, which passes `--no-verify` and is a `--dry-run`, so it neither runs a local hook nor reaches the remote. There is therefore no push to intercept between the two packages, and only the remote itself can advance in that gap. Counting receives rather than pushes also means the competing push this hook makes is itself counted, so it cannot re-trigger and recurse.
 */
async function landCommitAfterNthReceive(remote: string, remoteUrl: string, counterFile: string, sabotageOn: number): Promise<void> {
  await git(['config', 'core.hooksPath', 'hooks'], { cwd: remote });
  await writeFile(
    join(remote, 'hooks', 'post-receive'),
    [
      '#!/bin/sh',
      'set -e',
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_QUARANTINE_PATH GIT_PUSH_OPTION_COUNT',
      `COUNTER=${JSON.stringify(counterFile)}`,
      'echo receive >> "$COUNTER"',
      'COUNT=$(wc -l < "$COUNTER" | tr -d " ")',
      `if [ "$COUNT" -ne ${String(sabotageOn)} ]; then exit 0; fi`,
      'WORK=$(mktemp -d)',
      `git clone --quiet ${JSON.stringify(remoteUrl)} "$WORK/clone"`,
      'cd "$WORK/clone"',
      'git config user.name "Competing Pusher"',
      'git config user.email "competing@example.com"',
      'mkdir -p packages/b/src',
      'printf "export const competing = 1;\\n" > packages/b/src/competing.js',
      'git add -- packages/b/src/competing.js',
      'git commit --quiet -m "feat(b): competing feature landed between packages"',
      'git push --quiet origin HEAD:main',
      'rm -rf "$WORK"',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}


/** How many times one released package's own release reaches the remote under `commitStrategy: 'per-package'`: `\@semantic-release/git`'s prepare push, then semantic-release's own tag push and its separate notes push, then the orchestrator's dependency-bump push. */
const RECEIVES_PER_RELEASED_PACKAGE = 4;

describe('releaseWorkspace with commitStrategy "per-package" when the branch moves between packages', () => {
  it('releases the later packages against the new tip instead of silently skipping them', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } },
      ],
      [{ message: 'feat(a): a feature worth releasing', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }],
    );
    try {
      // @fixture/a's release reaches the remote four times: @semantic-release/git's prepare push, then core's tag push and its separate notes push, then the orchestrator's own dependency-bump push. Landing a commit right after the fourth leaves the branch stale for @fixture/b, which is the package that used to be skipped in silence.
      await landCommitAfterNthReceive(fixture.remote, pathToFileURL(fixture.remote).href, join(fixture.root, '..', 'receives.log'), RECEIVES_PER_RELEASED_PACKAGE);

      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: FIXTURE_PLUGINS, commitStrategy: 'per-package' });

      const byName = new Map(outcome.packages.map((pkg) => [pkg.name, pkg]));
      // @fixture/a published before the branch moved and must be left exactly as it was.
      expect(byName.get('@fixture/a')).toMatchObject({ released: true, version: '1.1.0' });
      // @fixture/b is the assertion that matters: before this fix it came back released: false, indistinguishable from having nothing to release, and the run still exited green. The version is the second half of it: a dependency bump alone would have made this a patch, so 1.1.0 is only reachable by analysing the competing feat that landed after @fixture/a finished, which means the version was recomputed against the new tip rather than replayed from the stale one.
      expect(byName.get('@fixture/b')).toMatchObject({ released: true, version: '1.1.0', type: 'minor' });

      const tags = (await git(['ls-remote', '--tags', fixture.remote], { cwd: fixture.root }))
        .split('\n')
        .map((line) => line.split('refs/tags/')[1])
        .filter((tag): tag is string => tag !== undefined && !tag.endsWith('^{}'));
      expect(tags).toContain('@fixture/a@1.1.0');
      expect(tags.some((tag) => tag.startsWith('@fixture/b@1.'))).toBe(true);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

});
