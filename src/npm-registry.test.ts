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

const NOT_FOUND = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 5.8.4' } });

describe('createNpmRegistryClient', () => {
  it('finds a version npm view reports', async () => {
    const pkg = await packageOnDisk({ name: 'pdf-codec', version: '5.8.4' });
    const npm = npmAnswering({ exitCode: 0, stdout: '"5.8.4"\n', stderr: '' });

    await expect(createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '5.8.4')).resolves.toBe(true);
    expect(npm.calls).toEqual([{ args: ['view', 'pdf-codec@5.8.4', 'version', '--json'], cwd: pkg.directory }]);
  });

  it('treats an E404 for the version or the whole package as absent', async () => {
    const pkg = await packageOnDisk({ name: 'pdf-codec', version: '5.8.4' });
    const npm = npmAnswering({ exitCode: 1, stdout: NOT_FOUND, stderr: 'npm error code E404' });

    await expect(createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '5.8.4')).resolves.toBe(false);
  });

  it('fails on an answer that is neither the version nor an E404, rather than reading it as absent', async () => {
    const pkg = await packageOnDisk({ name: 'pdf-codec', version: '5.8.4' });

    await expect(createNpmRegistryClient({ env: {}, run: npmAnswering({ exitCode: 0, stdout: '', stderr: '' }).run }).hasVersion(pkg, '5.8.4')).rejects.toBeInstanceOf(RegistryQueryError);
  });

  it('asks the registry the manifest publishes to', async () => {
    const pkg = await packageOnDisk({ name: 'pdf-codec', version: '5.8.4', publishConfig: { registry: 'https://npm.example.com/' } });
    const npm = npmAnswering({ exitCode: 0, stdout: '"5.8.4"', stderr: '' });

    await createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '5.8.4');
    expect(npm.calls[0]?.args).toEqual(['view', 'pdf-codec@5.8.4', 'version', '--json', '--registry', 'https://npm.example.com/']);
  });

  it('fails when the registry cannot answer, rather than guessing either way', async () => {
    const pkg = await packageOnDisk({ name: 'pdf-codec', version: '5.8.4' });
    const npm = npmAnswering({ exitCode: 1, stdout: JSON.stringify({ error: { code: 'ETIMEDOUT', summary: 'network timeout' } }), stderr: 'npm error code ETIMEDOUT' });

    await expect(createNpmRegistryClient({ env: {}, run: npm.run }).hasVersion(pkg, '5.8.4')).rejects.toBeInstanceOf(RegistryQueryError);
  });
});
