import { describe, expect, it } from 'vitest';
import { UnpublishedReleaseRecoveryError } from './errors';
import { git } from './git';
import { createWorkspaceFixture, type FixturePackage } from './git-workspace-fixture';
import type { PublishPluginSpec } from './plugins';
import type { RecoveryCandidate, RecoveryPublisher, RegistryClient, TaggedRelease } from './registry-recovery';
import { releaseWorkspace, type CommitStrategy } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

/**
 * A publishable package whose registry is a non-official URL nothing listens on. `@semantic-release/npm` verifies a token for such a registry without contacting it, so its `verifyConditions` step passes offline given any `NPM_TOKEN`, and the package counts as publishing (it is public and its plugin list includes `@semantic-release/npm` without `npmPublish: false`) without any test reaching a real registry.
 */
const PUBLISHING: FixturePackage = { name: '@fixture/a', version: '1.0.0', private: false, publishConfig: { registry: 'http://127.0.0.1:9/' } };

const PLUGINS: Readonly<Record<CommitStrategy, readonly PublishPluginSpec[]>> = {
  'per-package': ['@semantic-release/npm', '@semantic-release/git'],
  single: ['@semantic-release/npm'],
};

function offlineEnv(): NodeJS.ProcessEnv {
  return { ...releaseEnv(), NPM_TOKEN: 'fixture-token-never-sent' };
}

function registryWithout(missing: readonly string[]): RegistryClient & { readonly queried: string[] } {
  const queried: string[] = [];
  return {
    queried,
    hasVersion: async (pkg, version) => {
      queried.push(`${pkg.name}@${version}`);
      return Promise.resolve(!missing.includes(`${pkg.name}@${version}`));
    },
  };
}

function recordingPublisher(failure?: Error): RecoveryPublisher & { readonly published: string[] } {
  const published: string[] = [];
  return {
    published,
    publish: async ({ release }: RecoveryCandidate) => {
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      published.push(release.gitTag);
      return Promise.resolve();
    },
  };
}

async function remoteTags(remote: string): Promise<readonly string[]> {
  return (await git(['ls-remote', '--tags', remote], { cwd: process.cwd() }))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^.*refs\/tags\//, ''));
}

describe('releaseWorkspace recovering releases missing from the registry', () => {
  it.each<CommitStrategy>(['per-package', 'single'])('republishes a tagged release missing from the registry and reports it, under commitStrategy %s', async (commitStrategy) => {
    const fixture = await createWorkspaceFixture([PUBLISHING], []);
    try {
      const registry = registryWithout(['@fixture/a@1.0.0']);
      const publisher = recordingPublisher();
      const reported: TaggedRelease[] = [];

      const outcome = await releaseWorkspace({
        root: fixture.root,
        env: offlineEnv(),
        plugins: PLUGINS[commitStrategy],
        commitStrategy,
        registry,
        recoveryPublisher: publisher,
        onPublished: (release) => {
          reported.push(release);
        },
      });

      expect(publisher.published).toEqual(['@fixture/a@1.0.0']);
      expect(outcome.recovered).toEqual([{ name: '@fixture/a', version: '1.0.0', gitTag: '@fixture/a@1.0.0' }]);
      expect(reported).toEqual([{ name: '@fixture/a', version: '1.0.0', gitTag: '@fixture/a@1.0.0' }]);
      expect(outcome.packages).toMatchObject([{ name: '@fixture/a', released: false }]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('rejects an invalid packageSources before it republishes anything', async () => {
    const fixture = await createWorkspaceFixture([PUBLISHING], []);
    try {
      const publisher = recordingPublisher();
      await expect(
        releaseWorkspace({
          root: fixture.root,
          env: offlineEnv(),
          plugins: PLUGINS['per-package'],
          registry: registryWithout(['@fixture/a@1.0.0']),
          recoveryPublisher: publisher,
          packageSources: { '@fixture/a': ['../outside'] },
        }),
      ).rejects.toThrow(/packageSources is invalid/);
      expect(publisher.published).toEqual([]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('releases nothing new while a missing release cannot be republished', async () => {
    const fixture = await createWorkspaceFixture([PUBLISHING], [{ message: 'feat(a): something new', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } }]);
    try {
      const tagsBefore = await remoteTags(fixture.remote);

      await expect(
        releaseWorkspace({
          root: fixture.root,
          env: offlineEnv(),
          plugins: PLUGINS['per-package'],
          registry: registryWithout(['@fixture/a@1.0.0']),
          recoveryPublisher: recordingPublisher(new Error('npm error code TLOG_CREATE_ENTRY_ERROR')),
        }),
      ).rejects.toBeInstanceOf(UnpublishedReleaseRecoveryError);

      expect(await remoteTags(fixture.remote)).toEqual(tagsBefore);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('never consults the registry for a gated run, where a tag waits for resume to publish it', async () => {
    const fixture = await createWorkspaceFixture([PUBLISHING], []);
    try {
      const registry = registryWithout(['@fixture/a@1.0.0']);

      const outcome = await releaseWorkspace({ root: fixture.root, env: offlineEnv(), plugins: PLUGINS['per-package'], gatePublish: true, registry, recoveryPublisher: recordingPublisher() });

      expect(registry.queried).toEqual([]);
      expect(outcome.recovered).toBeUndefined();
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});
