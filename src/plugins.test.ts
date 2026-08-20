import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyzeCommitsContext } from 'semantic-release';
import { ReleaseConfigurationError } from './errors';
import { git, parseChangedPaths } from './git';
import { createScopedPlugins, filterCommitsToDirectory, parsePublishPluginSpec, resolvePublishPlugins } from './plugins';
import type { WorkspacePackage } from './workspace';

function commit(hash: string): { readonly hash: string } {
  return { hash };
}

/** A real, minimal git repository with a single commit and no tags -- the substrate `commitsForPackage` needs, since it runs a real `git log`. Deliberately lighter than `createWorkspaceFixture`, which tags every package it scaffolds and so cannot represent a package's first release. */
async function createUntaggedGitRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-plugins-'));
  await git(['init', '--initial-branch=main', directory], { cwd: directory });
  await git(['config', 'user.name', 'Fixture Release Bot'], { cwd: directory });
  await git(['config', 'user.email', 'fixture@example.com'], { cwd: directory });
  await git(['commit', '--allow-empty', '-m', 'chore: scaffold'], { cwd: directory });
  return directory;
}

function fakeWorkspacePackage(directory: string): WorkspacePackage {
  return {
    name: 'example',
    version: '0.0.0',
    directory,
    relativeDirectory: '.',
    repoRelativeDirectory: '.',
    manifestPath: join(directory, 'package.json'),
    dependencies: new Map(),
  };
}

/**
 * A test double for semantic-release's own analyze-commits context. semantic-release's real `getLastRelease` returns `{}` (not `undefined`, and not a fully-populated `LastRelease`) when a package has no prior tag -- contradicting its own type declaration, which is exactly why the production code under test reads `lastRelease` defensively rather than trusting the type. Only the fields `commitsForPackage` and the wrapped `@semantic-release/commit-analyzer` plugin actually read (`cwd`, `commits`, `lastRelease`, `logger.log`) are populated; the rest of semantic-release's `Context` surface (stdout, stderr, env, envCi, branch, branches, options) is never touched by either, and instantiating real values for them would add nothing but boilerplate.
 */
function fakeFirstReleaseContext(cwd: string): AnalyzeCommitsContext & { cwd: string } {
  return {
    cwd,
    commits: [],
    releases: [],
    lastRelease: {},
    logger: { log: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  } as unknown as AnalyzeCommitsContext & { cwd: string };
}

describe('parseChangedPaths', () => {
  it('maps each hash to the files its commit changed, merging commits with no file list', () => {
    const output = '\x1ehash1\n\npackages/a/src/index.js\npackages/a/package.json\n\x1ehash2\n\npackages/b/src/index.js\n\x1ehash3\n\n';
    expect(parseChangedPaths(output)).toEqual(
      new Map([
        ['hash1', new Set(['packages/a/src/index.js', 'packages/a/package.json'])],
        ['hash2', new Set(['packages/b/src/index.js'])],
        ['hash3', new Set()],
      ]),
    );
  });
});

describe('filterCommitsToDirectory', () => {
  const changedPaths = new Map<string, ReadonlySet<string>>([
    ['touches-a', new Set(['packages/a/src/index.js', 'README.md'])],
    ['touches-both', new Set(['packages/a/src/index.js', 'packages/ab/src/index.js'])],
    ['touches-sibling-directory-sharing-a-prefix', new Set(['packages/ab/src/index.js'])],
    ['touches-root-only', new Set(['README.md'])],
    ['merge-commit-no-files', new Set()],
  ]);

  it('keeps commits with at least one path under the package directory', () => {
    const kept = filterCommitsToDirectory(
      [commit('touches-a'), commit('touches-root-only'), commit('touches-sibling-directory-sharing-a-prefix')],
      changedPaths,
      'packages/a',
    );
    expect(kept.map((entry) => entry.hash)).toEqual(['touches-a']);
  });

  it('does not match a directory prefix onto a longer directory name', () => {
    expect(filterCommitsToDirectory([commit('touches-both')], changedPaths, 'packages/a')).toHaveLength(1);
    expect(filterCommitsToDirectory([commit('touches-sibling-directory-sharing-a-prefix')], changedPaths, 'packages/a')).toHaveLength(0);
  });

  it('drops merge commits, which carry their changes through their parents', () => {
    expect(filterCommitsToDirectory([commit('merge-commit-no-files')], changedPaths, 'packages/a')).toHaveLength(0);
  });

  it('keeps commits the path map does not cover, erring towards releasing', () => {
    expect(filterCommitsToDirectory([commit('not-in-map')], changedPaths, 'packages/a')).toHaveLength(1);
  });
});

describe('createScopedPlugins', () => {
  it('analyses a package on its first release, when there is no prior tag to diff commits from', async () => {
    const directory = await createUntaggedGitRepo();
    try {
      const scoped = createScopedPlugins({
        pkg: fakeWorkspacePackage(directory),
        analyzeCommitsConfig: {},
        generateNotesConfig: {},
        bumps: { bumpsFor: () => [] },
      });
      const result = await scoped.analyzeCommits({}, fakeFirstReleaseContext(directory));
      expect(result).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('resolvePublishPlugins', () => {
  it('resolves standard plugin names to absolute paths and carries their configs', () => {
    const resolved = resolvePublishPlugins(
      [
        '@semantic-release/npm',
        ['@semantic-release/git', { assets: ['package.json'] }],
      ],
      join(tmpdir(), 'nowhere-in-particular'),
      { requireGitPlugin: true },
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.[0]).toMatch(/@semantic-release[/\\]npm[/\\]index\.(js|cjs|mjs)$/);
    expect(resolved[0]?.[1]).toEqual({});
    expect(resolved[1]?.[1]).toEqual({ assets: ['package.json'] });
  });

  it('rejects the wrapped step plugins, whose config would otherwise be a silent no-op', () => {
    const call = (): readonly unknown[] => resolvePublishPlugins(['@semantic-release/commit-analyzer'], '/nonexistent-workspace-root', { requireGitPlugin: false });
    expect(call).toThrow(ReleaseConfigurationError);
    expect(call).toThrow(/analyzeCommits/);
  });

  it('rejects a real-mode pipeline without @semantic-release/git, which would leave manifests uncommitted', () => {
    const call = (): readonly unknown[] => resolvePublishPlugins(['@semantic-release/npm'], '/nonexistent-workspace-root', { requireGitPlugin: true });
    expect(call).toThrow(/@semantic-release\/git/);
  });

  it('allows a dry-run pipeline without @semantic-release/git', () => {
    expect(resolvePublishPlugins([], '/nonexistent-workspace-root', { requireGitPlugin: false })).toEqual([]);
  });

  it('reports both resolution bases when a plugin name resolves nowhere', () => {
    const call = (): readonly unknown[] => resolvePublishPlugins(['@semantic-release/not-a-plugin'], '/nonexistent-workspace-root', { requireGitPlugin: false });
    expect(call).toThrow(/this tool/);
    expect(call).toThrow(/the workspace root/);
  });
});

describe('parsePublishPluginSpec', () => {
  it('normalises every accepted shape to a name and config object', () => {
    expect(parsePublishPluginSpec('@semantic-release/npm')).toEqual(['@semantic-release/npm', {}]);
    expect(parsePublishPluginSpec(['@semantic-release/git'])).toEqual(['@semantic-release/git', {}]);
    expect(parsePublishPluginSpec(['@semantic-release/git', { assets: ['CHANGELOG.md'] }])).toEqual(['@semantic-release/git', { assets: ['CHANGELOG.md'] }]);
  });
});
