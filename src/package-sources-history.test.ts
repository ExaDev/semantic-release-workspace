import { describe, expect, it } from 'vitest';
import { ReleaseConfigurationError } from './errors';
import { buildDependencyGraph } from './graph';
import { type FixtureCommit, createWorkspaceFixture } from './git-workspace-fixture';
import { loadPackageSources } from './package-sources';
import { TestTimeoutMs } from './test-timeouts';
import { discoverWorkspace } from './workspace';

const seed: FixtureCommit = { message: 'chore: seed a crate', files: { 'rust/crates/shared/src/lib.rs': 'x\n' } };

async function load(
  commits: readonly FixtureCommit[],
  sources: Readonly<Record<string, readonly string[]>>,
  workspaceSubdirectory?: string,
  warn: (message: string) => void = () => undefined,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const fixture = await createWorkspaceFixture([{ name: '@fixture/a', version: '1.0.0' }], commits, workspaceSubdirectory === undefined ? {} : { workspaceSubdirectory });
  try {
    const workspace = await discoverWorkspace(fixture.root);
    return await loadPackageSources(buildDependencyGraph(workspace.packages), sources, { cwd: workspace.root, warn });
  } finally {
    await fixture.remove();
  }
}

describe('loadPackageSources', () => {
  it('accepts a path that matches a tracked file', async () => {
    expect((await load([seed], { '@fixture/a': ['rust/crates/shared'] })).get('@fixture/a')).toEqual(['rust/crates/shared']);
  }, TestTimeoutMs.Short);

  it('accepts a glob that matches a tracked file', async () => {
    expect((await load([seed], { '@fixture/a': ['rust/crates/*/src'] })).get('@fixture/a')).toEqual(['rust/crates/*/src']);
  }, TestTimeoutMs.Short);

  it('accepts a path whose every file a later commit deleted, since commits in the range still touched it', async () => {
    const deleted: FixtureCommit = { message: 'chore: remove the crate', remove: ['rust/crates/shared/src/lib.rs'] };
    expect((await load([seed, deleted], { '@fixture/a': ['rust/crates/shared'] })).get('@fixture/a')).toEqual(['rust/crates/shared']);
  }, TestTimeoutMs.Short);

  it('refuses a path that no commit and no tracked file ever matched, naming the package and the path', async () => {
    const failure = load([seed], { '@fixture/a': ['rust/crates/sharde'] });
    await expect(failure).rejects.toBeInstanceOf(ReleaseConfigurationError);
    await expect(failure).rejects.toThrow(/@fixture\/a: "rust\/crates\/sharde" matches no file/);
  }, TestTimeoutMs.Short);

  it('reads paths from the repository toplevel when the workspace is nested below it', async () => {
    const outside: FixtureCommit = { message: 'chore: seed a crate', files: { '../rust/crates/shared/src/lib.rs': 'x\n' } };
    expect((await load([outside], { '@fixture/a': ['rust/crates/shared'] }, 'mono')).get('@fixture/a')).toEqual(['rust/crates/shared']);
    await expect(load([seed], { '@fixture/a': ['rust/crates/shared'] }, 'mono')).rejects.toThrow(/matches no file/);
  }, TestTimeoutMs.Short);

  it('warns, naming the package and the path, about a path with no tracked file that history shows once existed', async () => {
    const renamed: FixtureCommit = { message: 'chore: remove the crate', remove: ['rust/crates/shared/src/lib.rs'] };
    const warnings: string[] = [];
    await load([seed, renamed], { '@fixture/a': ['rust/crates/shared'] }, undefined, (message) => {
      warnings.push(message);
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/@fixture\/a: "rust\/crates\/shared" matches no tracked file/);
  }, TestTimeoutMs.Short);

  it('does not warn about a path that still has a tracked file', async () => {
    const warnings: string[] = [];
    await load([seed], { '@fixture/a': ['rust/crates/shared'] }, undefined, (message) => {
      warnings.push(message);
    });
    expect(warnings).toEqual([]);
  }, TestTimeoutMs.Short);
});
