import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { readReleaseConfigFile } from './cli';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryConfigFile(filename: string, contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, filename);
  await writeFile(path, contents);
  return path;
}

describe('readReleaseConfigFile', () => {
  it('reads a JSON config file', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true, branches: ['main'] }));
    const config = readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main']);
  });

  it('reads a YAML config file', async () => {
    const path = await temporaryConfigFile('release.config.yaml', 'dryRun: true\nbranches:\n  - main\n');
    const config = readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main']);
  });

  it('reads a TypeScript config file exporting a plain object', async () => {
    const path = await temporaryConfigFile(
      'release.config.ts',
      "const config = { dryRun: true, branches: ['main', 'next'], analyzeCommits: { preset: 'conventionalcommits' } };\nexport default config;\n",
    );
    const config = readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main', 'next']);
    expect(config.analyzeCommits).toEqual({ preset: 'conventionalcommits' });
  });

  it('reads a CommonJS config file', async () => {
    const path = await temporaryConfigFile('release.config.cjs', "module.exports = { branches: ['main'] };\n");
    const config = readReleaseConfigFile(path);
    expect(config.branches).toEqual(['main']);
  });

  it('rejects a config file containing invalid JSON syntax', async () => {
    const path = await temporaryConfigFile('release.config.json', '{ "dryRun": true, }');
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/--config file .* could not be loaded/);
  });

  it('rejects a TypeScript config file that throws during execution', async () => {
    const path = await temporaryConfigFile('release.config.ts', "throw new Error('boom');\n");
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/--config file .* could not be loaded/);
  });

  it('rejects a TypeScript config file whose default export fails shape validation', async () => {
    const path = await temporaryConfigFile('release.config.ts', "export default { dryRun: 'not-a-boolean' };\n");
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/"dryRun" must be a boolean/);
  });

  it('rejects an empty config file', async () => {
    const path = await temporaryConfigFile('release.config.json', '');
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/is empty/);
  });

  it('rejects a config file with an unknown option', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ notARealOption: true }));
    expect(() => readReleaseConfigFile(path)).toThrow(/unknown option/);
  });

  it('reads a commitStrategy of "single"', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ commitStrategy: 'single' }));
    expect(readReleaseConfigFile(path).commitStrategy).toBe('single');
  });

  it('leaves commitStrategy undefined when the config file omits it, so releaseWorkspace applies its own "per-package" default', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true }));
    expect(readReleaseConfigFile(path).commitStrategy).toBeUndefined();
  });

  it('rejects a commitStrategy that is not "per-package" or "single"', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ commitStrategy: 'per-commit' }));
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/"commitStrategy" must be one of/);
  });

  it('rejects a missing config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-cli-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'does-not-exist.json');
    expect(() => readReleaseConfigFile(path)).toThrow(InvalidArgumentError);
    expect(() => readReleaseConfigFile(path)).toThrow(/--config file .* could not be loaded/);
  });
});
