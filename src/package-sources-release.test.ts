import type { GenerateNotesInput } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';
import { commitOf, readCommits } from './git';
import { type FixtureCommit, type FixturePackage, createWorkspaceFixture } from './git-workspace-fixture';
import { createScopedPlugins } from './plugins';
import { discoverWorkspace } from './workspace';
import { releaseWorkspace, type ReleaseWorkspaceOptions } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

const packages: readonly FixturePackage[] = [
  { name: '@fixture/a', version: '1.0.0' },
  { name: '@fixture/b', version: '1.0.0' },
  { name: '@fixture/c', version: '1.0.0' },
];

const crateCommit: FixtureCommit = { message: 'fix(crate): correct the parser', files: { 'rust/crates/shared/src/lib.rs': 'pub fn parse() {}\n' } };
const unrelatedCommit: FixtureCommit = { message: 'fix(docs): correct a typo', files: { 'docs/guide.md': 'text\n' } };

/** Runs a dry release over `packages` after `commits` and reports each package's next version, undefined when it would not release. */
async function dryRun(commits: readonly FixtureCommit[], options: Pick<ReleaseWorkspaceOptions, 'packageSources' | 'commitStrategy'>): Promise<ReadonlyMap<string, string | undefined>> {
  const fixture = await createWorkspaceFixture(packages, commits);
  try {
    const outcome = await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [], ...options });
    return new Map(outcome.packages.map((pkg) => [pkg.name, pkg.version]));
  } finally {
    await fixture.remove();
  }
}

/** The release notes `createScopedPlugins` generates for the package in directory `directory` over everything since its first tag, from a real fixture history. */
async function notesFor(directory: string, commits: readonly FixtureCommit[], sources: readonly string[]): Promise<string> {
  const fixture = await createWorkspaceFixture(packages, commits);
  try {
    const workspace = await discoverWorkspace(fixture.root);
    const pkg = workspace.packages.find((entry) => entry.relativeDirectory === `packages/${directory}`);
    if (pkg === undefined) {
      throw new Error(`The fixture has no package in packages/${directory}.`);
    }
    const tag = `${pkg.name}@1.0.0`;
    const gitHead = await commitOf(tag, { cwd: fixture.root });
    const head = await commitOf('HEAD', { cwd: fixture.root });
    const scoped = createScopedPlugins({ pkg, analyzeCommitsConfig: {}, generateNotesConfig: {}, bumps: { bumpsFor: () => [] }, sources });
    // Only the fields the wrapped notes generator reads are populated; the rest of semantic-release's context carries nothing it uses.
    const context = {
      cwd: pkg.directory,
      commits: await readCommits(`${tag}..HEAD`, { cwd: fixture.root }),
      lastRelease: { version: '1.0.0', gitTag: tag, gitHead, name: tag, channels: [] },
      nextRelease: { type: 'patch', version: '1.0.1', gitTag: `${pkg.name}@1.0.1`, gitHead: head, name: `${pkg.name}@1.0.1`, channel: null },
      options: { repositoryUrl: 'https://github.com/example/example' },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined, success: () => undefined },
    } as unknown as GenerateNotesInput & { cwd: string };
    const notes = await scoped.generateNotes({}, context);
    if (typeof notes !== 'string') {
      throw new Error('No release notes were generated.');
    }
    return notes;
  } finally {
    await fixture.remove();
  }
}

describe('packageSources against a real git workspace', () => {
  it('releases the package whose extra path a commit touched, and no other', async () => {
    const versions = await dryRun([crateCommit], { packageSources: { '@fixture/a': ['rust/crates/shared'] } });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
    expect(versions.get('@fixture/c')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('releases nothing for a commit touching neither a package nor an extra path', async () => {
    const versions = await dryRun([unrelatedCommit], { packageSources: { '@fixture/a': ['rust/crates/shared'] } });
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

  it('includes the extra-path commit in the release notes', async () => {
    const notes = await notesFor('a', [crateCommit], ['rust/crates/shared']);
    expect(notes).toContain('correct the parser');
  }, TestTimeoutMs.Long);

  it('leaves an extra-path commit out of the notes of a package that does not list the path', async () => {
    const commits = [crateCommit, { message: 'fix(b): correct b', files: { 'packages/b/src/fix.js': 'export {};\n' } }];
    const notes = await notesFor('b', commits, []);
    expect(notes).toContain('correct b');
    expect(notes).not.toContain('correct the parser');
  }, TestTimeoutMs.Long);

  it('matches a glob, and only the paths it names', async () => {
    const created: FixtureCommit = { message: 'chore: add a source', files: { 'rust/bindings/wasm/src/old.rs': 'x\n' } };
    const globbed = await dryRun([created, crateCommit], { packageSources: { '@fixture/a': ['rust/crates/*/src'] } });
    expect(globbed.get('@fixture/a')).toBe('1.0.1');
    const ignored = await dryRun([created, { message: 'fix(wasm): handle input', files: { 'rust/bindings/wasm/src/new.rs': 'y\n' } }], { packageSources: { '@fixture/a': ['rust/crates/*/src'] } });
    expect(ignored.get('@fixture/a')).toBeUndefined();
  }, TestTimeoutMs.Long);

  it('applies the same widening under commitStrategy single', async () => {
    const versions = await dryRun([crateCommit], { packageSources: { '@fixture/a': ['rust/crates/shared'] }, commitStrategy: 'single' });
    expect(versions.get('@fixture/a')).toBe('1.0.1');
    expect(versions.get('@fixture/b')).toBeUndefined();
  }, TestTimeoutMs.Long);
});
