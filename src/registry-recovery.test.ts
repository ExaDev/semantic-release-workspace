import { describe, expect, it } from 'vitest';
import { UnpublishedReleaseRecoveryError } from './errors';
import { buildDependencyGraph, topologicalOrder } from './graph';
import {
  recoverUnpublishedReleases,
  type RecoveryCandidate,
  type RecoveryPublisher,
  type RegistryClient,
  type ReleasedTagSource,
  type TaggedRelease,
} from './registry-recovery';
import type { WorkspacePackage } from './workspace';

function packageFixture(name: string, dependencies: Readonly<Record<string, string>> = {}, isPrivate = false): WorkspacePackage {
  return {
    name,
    version: '1.0.0',
    private: isPrivate,
    directory: `/work/packages/${name}`,
    relativeDirectory: `packages/${name}`,
    repoRelativeDirectory: `packages/${name}`,
    manifestPath: `/work/packages/${name}/package.json`,
    dependencies: new Map([['dependencies', new Map(Object.entries(dependencies))]]),
  };
}

/** Tags keyed by package name, so a test states each package's highest released version in one place. */
function tagsFrom(versions: Readonly<Record<string, string>>): ReleasedTagSource {
  return {
    latestRelease: async (pkg) => {
      const version = versions[pkg.name];
      return Promise.resolve(version === undefined ? undefined : { version, gitTag: `${pkg.name}@${version}` });
    },
  };
}

/** A registry holding exactly the `name@version` pairs given, recording every lookup so a test can tell which packages were queried. */
function fakeRegistry(present: readonly string[]): RegistryClient & { readonly queried: string[] } {
  const queried: string[] = [];
  return {
    queried,
    hasVersion: async (pkg, version) => {
      queried.push(`${pkg.name}@${version}`);
      return Promise.resolve(present.includes(`${pkg.name}@${version}`));
    },
  };
}

/** Records every publish in call order; a tag listed in `failures` throws the paired error instead. */
function fakePublisher(failures: ReadonlyMap<string, Error> = new Map()): RecoveryPublisher & { readonly published: string[] } {
  const published: string[] = [];
  return {
    published,
    publish: async (candidate: RecoveryCandidate) => {
      const failure = failures.get(candidate.release.gitTag);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      published.push(candidate.release.gitTag);
      return Promise.resolve();
    },
  };
}

function workspaceOf(packages: readonly WorkspacePackage[]) {
  const graph = buildDependencyGraph(packages);
  return { graph, order: topologicalOrder(graph) };
}

const chain = [packageFixture('a'), packageFixture('b', { a: '^5.8.4' }), packageFixture('c', { b: '^14.10.12' })];

describe('recoverUnpublishedReleases', () => {
  it('republishes every tagged version missing from the registry, in dependency order', async () => {
    const { graph, order } = workspaceOf(chain);
    const registry = fakeRegistry([]);
    const publisher = fakePublisher();
    const reported: TaggedRelease[] = [];

    const recovered = await recoverUnpublishedReleases(
      { graph, order, publishes: () => true, dryRun: false, log: () => undefined, onRecovered: (release) => { reported.push(release); } },
      { tags: tagsFrom({ a: '5.8.4', b: '14.10.12', c: '5.12.167' }), registry, publisher },
    );

    expect(publisher.published).toEqual(['a@5.8.4', 'b@14.10.12', 'c@5.12.167']);
    expect(recovered.map((release) => release.gitTag)).toEqual(['a@5.8.4', 'b@14.10.12', 'c@5.12.167']);
    expect(reported.map((release) => release.gitTag)).toEqual(['a@5.8.4', 'b@14.10.12', 'c@5.12.167']);
  });

  it('leaves a tagged version the registry already has alone', async () => {
    const { graph, order } = workspaceOf(chain);
    const registry = fakeRegistry(['a@5.8.4', 'b@14.10.12', 'c@5.12.167']);
    const publisher = fakePublisher();

    const recovered = await recoverUnpublishedReleases(
      { graph, order, publishes: () => true, dryRun: false, log: () => undefined },
      { tags: tagsFrom({ a: '5.8.4', b: '14.10.12', c: '5.12.167' }), registry, publisher },
    );

    expect(registry.queried).toEqual(['a@5.8.4', 'b@14.10.12', 'c@5.12.167']);
    expect(publisher.published).toEqual([]);
    expect(recovered).toEqual([]);
  });

  it('never queries the registry for a package that does not publish, or one with no release tag yet', async () => {
    const { graph, order } = workspaceOf([packageFixture('a'), packageFixture('web', {}, true), packageFixture('fresh')]);
    const registry = fakeRegistry([]);
    const publisher = fakePublisher();

    await recoverUnpublishedReleases(
      { graph, order, publishes: (pkg) => !pkg.private, dryRun: false, log: () => undefined },
      { tags: tagsFrom({ a: '1.0.0', web: '2.0.0' }), registry, publisher },
    );

    expect(registry.queried).toEqual(['a@1.0.0']);
    expect(publisher.published).toEqual(['a@1.0.0']);
  });

  it('reports a failed publish, publishes none of its dependants, still publishes independent packages, and fails the run', async () => {
    const { graph, order } = workspaceOf([...chain, packageFixture('z')]);
    const publisher = fakePublisher(new Map([['a@5.8.4', new Error('npm error code TLOG_CREATE_ENTRY_ERROR (500) unexpected result from transparency log')]]));

    const run = recoverUnpublishedReleases(
      { graph, order, publishes: () => true, dryRun: false, log: () => undefined },
      { tags: tagsFrom({ a: '5.8.4', b: '14.10.12', c: '5.12.167', z: '1.0.107' }), registry: fakeRegistry([]), publisher },
    );

    const error = await run.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnpublishedReleaseRecoveryError);
    expect(error).toMatchObject({
      failed: [{ gitTag: 'a@5.8.4' }],
      blocked: [{ gitTag: 'b@14.10.12' }, { gitTag: 'c@5.12.167' }],
      recovered: [{ gitTag: 'z@1.0.107' }],
    });
    expect(String(error)).toContain('TLOG_CREATE_ENTRY_ERROR');
    expect(publisher.published).toEqual(['z@1.0.107']);
  });

  it('counts a publish the registry refuses as a version it already has as a success', async () => {
    const { graph, order } = workspaceOf(chain);
    const alreadyThere = new Error(
      'Command failed with exit code 1: npm publish /work/packages/a\nnpm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/a - You cannot publish over the previously published versions: 5.8.4.',
    );
    const publisher = fakePublisher(new Map([['a@5.8.4', alreadyThere]]));

    const recovered = await recoverUnpublishedReleases(
      { graph, order, publishes: () => true, dryRun: false, log: () => undefined },
      { tags: tagsFrom({ a: '5.8.4', b: '14.10.12', c: '5.12.167' }), registry: fakeRegistry([]), publisher },
    );

    expect(publisher.published).toEqual(['b@14.10.12', 'c@5.12.167']);
    expect(recovered.map((release) => release.gitTag)).toEqual(['b@14.10.12', 'c@5.12.167']);
  });

  it('fails a publish the registry refuses for any other reason', async () => {
    const { graph, order } = workspaceOf([packageFixture('a')]);
    const forbidden = new Error('npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/a - You do not have permission to publish "a".');

    await expect(
      recoverUnpublishedReleases(
        { graph, order, publishes: () => true, dryRun: false, log: () => undefined },
        { tags: tagsFrom({ a: '5.8.4' }), registry: fakeRegistry([]), publisher: fakePublisher(new Map([['a@5.8.4', forbidden]])) },
      ),
    ).rejects.toBeInstanceOf(UnpublishedReleaseRecoveryError);
  });

  it('reports what a dry run would republish without publishing it', async () => {
    const { graph, order } = workspaceOf(chain);
    const publisher = fakePublisher();
    const lines: string[] = [];

    const recovered = await recoverUnpublishedReleases(
      { graph, order, publishes: () => true, dryRun: true, log: (line) => { lines.push(line); } },
      { tags: tagsFrom({ a: '5.8.4', b: '14.10.12' }), registry: fakeRegistry(['b@14.10.12']), publisher },
    );

    expect(publisher.published).toEqual([]);
    expect(recovered.map((release) => release.gitTag)).toEqual(['a@5.8.4']);
    expect(lines.some((line) => line.includes('a@5.8.4'))).toBe(true);
  });
});
