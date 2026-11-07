import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryQueryError } from './errors';
import type { CommandResult } from './exec-file';
import { createNpmRegistryClient } from './npm-registry';
import type { WorkspacePackage } from './workspace';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function packageOnDisk(manifest: Record<string, unknown>): Promise<WorkspacePackage> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-registry-'));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, 'package.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    private: false,
    directory,
    relativeDirectory: 'packages/a',
    repoRelativeDirectory: 'packages/a',
    manifestPath,
    dependencies: new Map(),
  };
}

/** Answers every `npm` call with `result`, recording the arguments and working directory of each. */
function npmAnswering(result: CommandResult) {
  const calls: { readonly args: readonly string[]; readonly cwd: string }[] = [];
  return {
    calls,
    run: async (_command: string, args: readonly string[], options: { readonly cwd: string }) => {
      calls.push({ args, cwd: options.cwd });
      return Promise.resolve(result);
    },
  };
}

/**
 * What `npm view <name>@<version> version --json` really prints, recorded from npm 11.21.1 and npm 12.2.1 against registry.npmjs.org (and, for the network failure, a port nothing listens on), with the package name replaced. The two majors differ only for a published version: npm 11 prints the version as a JSON string, npm 12 as a one-element JSON array. Both print an E404 or a network failure as a JSON error object on stdout, exiting 1, with `npm error code <code>` on stderr.
 */
const RECORDED = {
  'npm 11': {
    published: { exitCode: 0, stdout: '"2.0.2"\n', stderr: '' },
    unpublishedVersion: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 99.0.0', detail: "The requested resource 'example-codec@99.0.0' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url." } }, null, 2)}\n`,
      stderr: 'npm error code E404\nnpm error 404 No match found for version 99.0.0\nnpm error 404\n',
    },
    unknownPackage: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/@example%2fmissing - Not found', detail: "The requested resource '@example/missing@1.0.0' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url." } }, null, 2)}\n`,
      stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing - Not found\nnpm error 404\n',
    },
    networkFailure: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'FetchError: request to http://127.0.0.1:9/example-codec failed, reason: connect ECONNREFUSED 127.0.0.1:9', detail: "If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'" } }, null, 2)}\n`,
      stderr: 'npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\n',
    },
  },
  'npm 12': {
    published: { exitCode: 0, stdout: '[\n  "2.0.2"\n]\n', stderr: '' },
    unpublishedVersion: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 99.0.0', detail: "The requested resource 'example-codec@99.0.0' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url." } }, null, 2)}\n`,
      stderr: 'npm error code E404\nnpm error 404 No match found for version 99.0.0\nnpm error 404\n',
    },
    unknownPackage: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/@example%2fmissing - Not found', detail: "The requested resource '@example/missing@1.0.0' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url." } }, null, 2)}\n`,
      stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@example%2fmissing - Not found\nnpm error 404\n',
    },
    networkFailure: {
      exitCode: 1,
      stdout: `${JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'FetchError: request to http://127.0.0.1:9/example-codec failed, reason: connect ECONNREFUSED 127.0.0.1:9', detail: "If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'" } }, null, 2)}\n`,
      stderr: 'npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\n',
    },
  },
} as const satisfies Record<string, Record<string, CommandResult>>;

const NPM_MAJORS = ['npm 11', 'npm 12'] as const;

describe('createNpmRegistryClient', () => {
  it.each(NPM_MAJORS)('finds a published version in %s\'s answer', async (major) => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '2.0.2' });
    const npm = npmAnswering(RECORDED[major].published);

    await expect(createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '2.0.2')).resolves.toBe(true);
    expect(npm.calls).toEqual([{ args: ['view', 'example-codec@2.0.2', 'version', '--json'], cwd: pkg.directory }]);
  });

  it.each(NPM_MAJORS)('treats %s\'s E404 for a missing version as absent', async (major) => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '99.0.0' });

    await expect(createNpmRegistryClient({ env: {}, run: npmAnswering(RECORDED[major].unpublishedVersion).run }).hasVersion(pkg, '99.0.0')).resolves.toBe(false);
  });

  it.each(NPM_MAJORS)('treats %s\'s E404 for a package the registry has never seen as absent', async (major) => {
    const pkg = await packageOnDisk({ name: '@example/missing', version: '1.0.0' });

    await expect(createNpmRegistryClient({ env: {}, run: npmAnswering(RECORDED[major].unknownPackage).run }).hasVersion(pkg, '1.0.0')).resolves.toBe(false);
  });

  it('treats an E404 npm reports only on stderr as absent', async () => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '99.0.0' });
    const stderrOnly = { ...RECORDED['npm 12'].unpublishedVersion, stdout: '' };

    await expect(createNpmRegistryClient({ env: {}, run: npmAnswering(stderrOnly).run }).hasVersion(pkg, '99.0.0')).resolves.toBe(false);
  });

  it.each(NPM_MAJORS)('fails on %s\'s network failure, rather than guessing either way', async (major) => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '2.0.2' });

    await expect(createNpmRegistryClient({ env: {}, run: npmAnswering(RECORDED[major].networkFailure).run }).hasVersion(pkg, '2.0.2')).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([
    ['nothing at all', ''],
    ['an empty list', '[]'],
    ['a list of other versions', '["2.0.1"]'],
    ['a different version', '"2.0.1"'],
    ['an object', '{"version":"2.0.2"}'],
  ])('fails loudly on %s, never counting it as published, and names what it parsed', async (_shape, stdout) => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '2.0.2' });
    const client = createNpmRegistryClient({ env: {}, run: npmAnswering({ exitCode: 0, stdout, stderr: '' }).run });

    const error = await client.hasVersion(pkg, '2.0.2').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RegistryQueryError);
    expect(String(error)).toContain(`parsed as ${stdout === '' ? '""' : JSON.stringify(JSON.parse(stdout))}`);
  });

  it('asks the registry the manifest publishes to', async () => {
    const pkg = await packageOnDisk({ name: 'example-codec', version: '2.0.2', publishConfig: { registry: 'https://npm.example.com/' } });
    const npm = npmAnswering(RECORDED['npm 12'].published);

    await createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '2.0.2');
    expect(npm.calls[0]?.args).toEqual(['view', 'example-codec@2.0.2', 'version', '--json', '--registry', 'https://npm.example.com/']);
  });
});
