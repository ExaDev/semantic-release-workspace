import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FixtureCommit, type FixturePackage, type WorkspaceFixtureOptions, createWorkspaceFixture } from './git-workspace-fixture';
import { isJsonObject } from './json';
import { type PublishPluginSpec } from './plugins';
import { resumeWorkspaceRelease } from './gate-publish';
import { releaseWorkspace, type ReleaseWorkspaceOptions } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

const packages: readonly FixturePackage[] = [
  { name: '@fixture/a', version: '1.0.0' },
  { name: '@fixture/b', version: '1.0.0' },
  { name: '@fixture/c', version: '1.0.0' },
];

/** A commit that touches only the shared crate, which `@fixture/a` (and sometimes `@fixture/b`) lists as a source. */
const crateCommit: FixtureCommit = { message: 'fix(crate): correct the parser', files: { 'rust/crates/shared/src/lib.rs': 'pub fn parse() {}\n' } };
/** Puts the crate in history without releasing anything, so a source path that a test lists exists and the test's own commits are what it measures. */
const seedCommit: FixtureCommit = { message: 'chore: seed the crate', files: { 'rust/crates/shared/src/lib.rs': 'pub fn seed() {}\n' } };
const unrelatedCommit: FixtureCommit = { message: 'fix(docs): correct a typo', files: { 'docs/guide.md': 'text\n' } };

type Options = Pick<ReleaseWorkspaceOptions, 'packageSources' | 'commitStrategy'>;

/** Runs a dry release over `packages` after `commits` and reports each package's next version, undefined when it would not release. */
async function dryRun(commits: readonly FixtureCommit[], options: Options, fixtureOptions: WorkspaceFixtureOptions = {}): Promise<ReadonlyMap<string, string | undefined>> {
  const fixture = await createWorkspaceFixture(packages, commits, fixtureOptions);
  try {
    const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [], ...options });
    return new Map(outcome.packages.map((pkg) => [pkg.name, pkg.version]));
  } finally {
    await fixture.remove();
  }
}

/** A publish-step plugin recording the notes each release carries, in a directory outside the fixture repository so it never dirties the working tree. */
async function writeNotesPlugin(directory: string): Promise<{ readonly modulePath: string; readonly notes: () => Promise<ReadonlyMap<string, string>> }> {
  const modulePath = join(directory, 'notes-plugin.js');
  const notesFile = join(directory, 'notes.json');
  await writeFile(notesFile, '{}');
  await writeFile(
    modulePath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const NOTES_FILE = ${JSON.stringify(notesFile)};`,
      'export async function publish(pluginConfig, context) {',
      '  const notes = JSON.parse(readFileSync(NOTES_FILE, "utf8"));',
      '  notes[context.nextRelease.gitTag] = context.nextRelease.notes;',
      '  writeFileSync(NOTES_FILE, JSON.stringify(notes));',
      '  return { name: context.nextRelease.gitTag };',
      '}',
      '',
    ].join('\n'),
  );
  return {
    modulePath,
    notes: async () => {
      const parsed: unknown = JSON.parse(await readFile(notesFile, 'utf8'));
      if (!isJsonObject(parsed)) {
        throw new Error(`${notesFile} does not hold a notes object.`);
      }
      return new Map(Object.entries(parsed).flatMap(([tag, notes]) => (typeof notes === 'string' ? [[tag, notes] as const] : [])));
    },
  };
}

const NPM_WITHOUT_PUBLISH: PublishPluginSpec = ['@semantic-release/npm', { npmPublish: false }];
const GIT_RELEASE_COMMIT: PublishPluginSpec = ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }];

/** Releases for real after `commits` and returns the notes each release was published with, keyed by tag. */
async function releaseNotes(commits: readonly FixtureCommit[], packageSources: ReleaseWorkspaceOptions['packageSources'], commitStrategy: 'per-package' | 'single' = 'per-package'): Promise<ReadonlyMap<string, string>> {
  const fixture = await createWorkspaceFixture(packages, commits);
  const pluginDirectory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-notes-plugin-'));
  try {
    const notesPlugin = await writeNotesPlugin(pluginDirectory);
    const plugins = commitStrategy === 'single' ? [NPM_WITHOUT_PUBLISH, notesPlugin.modulePath] : [NPM_WITHOUT_PUBLISH, GIT_RELEASE_COMMIT, notesPlugin.modulePath];
    await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins, packageSources, commitStrategy });
    return await notesPlugin.notes();
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
    await fixture.remove();
  }
}

const sourcesOfA = { '@fixture/a': ['rust/crates/shared'] };

describe('packageSources against a real git workspace', () => {
  it('releases the package whose extra path a commit touched, and no other', async () => {
    const versions = await dryRun([crateCommit], { packageSources: sourcesOfA });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
    expect(versions.get('@fixture/c')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('releases nothing for a commit touching neither a package nor an extra path', async () => {
    const versions = await dryRun([seedCommit, unrelatedCommit], { packageSources: sourcesOfA });
    expect([...versions.values()]).toEqual([undefined, undefined, undefined]);
  }, TestTimeoutMs.Long);

  it('releases nothing for an extra-path commit when no packageSources are configured', async () => {
    const versions = await dryRun([crateCommit], {});
    expect([...versions.values()]).toEqual([undefined, undefined, undefined]);
  }, TestTimeoutMs.Long);

  it('releases every package that lists the same extra path', async () => {
    const versions = await dryRun([crateCommit], { packageSources: { '@fixture/a': ['rust/crates/shared'], '@fixture/b': ['rust/crates/shared'] } });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBe('1.0.1');
    expect(versions.get('@fixture/c')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('matches a glob, and only the paths it names', async () => {
    const globbed = await dryRun([seedCommit, crateCommit], { packageSources: { '@fixture/a': ['rust/crates/*/src'] } });
    expect(globbed.get('@fixture/a')).toBe('1.0.1');
    const wasm: FixtureCommit = { message: 'fix(wasm): handle input', files: { 'rust/bindings/wasm/src/new.rs': 'y\n' } };
    const ignored = await dryRun([seedCommit, wasm], { packageSources: { '@fixture/a': ['rust/crates/*/src'] } });
    expect(ignored.get('@fixture/a')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('releases the package when a commit only deletes a file under its extra path', async () => {
    const versions = await dryRun([seedCommit, { message: 'fix(crate): drop the seed', remove: ['rust/crates/shared/src/lib.rs'] }], { packageSources: sourcesOfA });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('reads extra paths from the repository root when the workspace sits below it', async () => {
    const outside: FixtureCommit = { message: 'fix(crate): correct the parser', files: { '../rust/crates/shared/src/lib.rs': 'pub fn parse() {}\n' } };
    const versions = await dryRun([outside], { packageSources: sourcesOfA }, { workspaceSubdirectory: 'mono' });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('does not count a same-named directory inside the workspace as the extra path when the workspace sits below the repository root', async () => {
    const outside: FixtureCommit = { message: 'chore: seed the crate', files: { '../rust/crates/shared/src/lib.rs': 'x\n' } };
    const inside: FixtureCommit = { message: 'fix(crate): inside the workspace', files: { 'rust/crates/shared/src/lib.rs': 'y\n' } };
    const versions = await dryRun([outside, inside], { packageSources: sourcesOfA }, { workspaceSubdirectory: 'mono' });
    expect(versions.get('@fixture/a')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('refuses a source path that matches nothing before anything releases', async () => {
    await expect(dryRun([crateCommit], { packageSources: { '@fixture/a': ['rust/crates/sharde'] } })).rejects.toThrow(/matches no file in this repository's history/);
  }, TestTimeoutMs.Long);

  it('applies the same widening under commitStrategy single', async () => {
    const versions = await dryRun([crateCommit], { packageSources: sourcesOfA, commitStrategy: 'single' });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('detaches a gated release for the package whose extra path changed, and no other', async () => {
    const fixture = await createWorkspaceFixture(packages, [crateCommit]);
    try {
      const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), plugins: [NPM_WITHOUT_PUBLISH, GIT_RELEASE_COMMIT], packageSources: sourcesOfA, gatePublish: true });
      const byName = new Map((outcome.detached ?? []).map((entry) => [entry.name, entry]));
      expect(byName.get('@fixture/a')?.state?.nextRelease.version).toBe('1.0.1');
      expect(byName.get('@fixture/b')?.state).toBeNull();
      await resumeWorkspaceRelease({ root: fixture.root, env: releaseEnv(), detached: outcome.detached ?? [] });
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});

describe('packageSources in the release notes', () => {
  const second: FixtureCommit = { message: 'fix(a): second change', files: { 'packages/a/src/second.js': 'export {};\n' } };
  const third: FixtureCommit = {
    message: 'fix(a): third change',
    files: { 'packages/a/src/third.js': 'export {};\n', 'rust/crates/shared/src/third.rs': 'z\n' },
  };

  it('lists each commit once, whether it touched the package directory, the extra path or both', async () => {
    const notes = (await releaseNotes([{ ...crateCommit, message: 'fix(crate): first change' }, second, third], sourcesOfA)).get('@fixture/a@1.0.1') ?? '';
    for (const subject of ['first change', 'second change', 'third change']) {
      expect(notes.split(subject)).toHaveLength(2);
    }
  }, TestTimeoutMs.Long);

  it('leaves the extra-path commit out of the notes of a package that does not list the path', async () => {
    const notes = await releaseNotes([crateCommit, { message: 'fix(b): correct b', files: { 'packages/b/src/fix.js': 'export {};\n' } }], sourcesOfA);
    expect(notes.get('@fixture/b@1.0.1')).toContain('correct b');
    expect(notes.get('@fixture/b@1.0.1')).not.toContain('correct the parser');
    expect(notes.get('@fixture/a@1.0.1')).toContain('correct the parser');
  }, TestTimeoutMs.Long);

  it('lists the extra-path commit under commitStrategy single', async () => {
    const notes = await releaseNotes([crateCommit], sourcesOfA, 'single');
    expect(notes.get('@fixture/a@1.0.1')).toContain('correct the parser');
  }, TestTimeoutMs.Long);
});
