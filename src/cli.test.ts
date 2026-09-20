import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram, readReleaseConfigFile } from './cli';
import { git } from './git';
import { createWorkspaceFixture, type FixturePackage } from './git-workspace-fixture';
import { type PublishPluginSpec } from './plugins';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
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
    const config = await readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main']);
  });

  it('reads a YAML config file', async () => {
    const path = await temporaryConfigFile('release.config.yaml', 'dryRun: true\nbranches:\n  - main\n');
    const config = await readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main']);
  });

  it('reads a TypeScript config file exporting a plain object', async () => {
    const path = await temporaryConfigFile(
      'release.config.ts',
      "const config = { dryRun: true, branches: ['main', 'next'], analyzeCommits: { preset: 'conventionalcommits' } };\nexport default config;\n",
    );
    const config = await readReleaseConfigFile(path);
    expect(config.dryRun).toBe(true);
    expect(config.branches).toEqual(['main', 'next']);
    expect(config.analyzeCommits).toEqual({ preset: 'conventionalcommits' });
  });

  it('reads the default export of a TypeScript config file that also has type annotations, a type-only import, and named exports', async () => {
    const path = await temporaryConfigFile(
      'release.config.ts',
      [
        "import type { ReleaseWorkspaceOptions } from '@exadev/semantic-release-workspace';",
        "export const commitTypes: readonly string[] = ['feat', 'fix'];",
        "const config: Pick<ReleaseWorkspaceOptions, 'dryRun' | 'branches'> = { dryRun: false, branches: ['main'] };",
        'export default config;',
        '',
      ].join('\n'),
    );
    const config = await readReleaseConfigFile(path);
    expect(config.dryRun).toBe(false);
    expect(config.branches).toEqual(['main']);
  });

  it('reads the default export of an ES module config file', async () => {
    const path = await temporaryConfigFile('release.config.mjs', "export default { branches: ['main'] };\n");
    expect((await readReleaseConfigFile(path)).branches).toEqual(['main']);
  });

  it('rejects a TypeScript config file using syntax that cannot be type-stripped, as a load failure', async () => {
    const path = await temporaryConfigFile('release.config.ts', "enum Level { Patch }\nexport default { branches: [Level[0]] };\n");
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .* could not be loaded/);
  });

  it('reads a CommonJS config file', async () => {
    const path = await temporaryConfigFile('release.config.cjs', "module.exports = { branches: ['main'] };\n");
    const config = await readReleaseConfigFile(path);
    expect(config.branches).toEqual(['main']);
  });

  it('rejects a config file containing invalid JSON syntax', async () => {
    const path = await temporaryConfigFile('release.config.json', '{ "dryRun": true, }');
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .* could not be loaded/);
  });

  it('rejects a TypeScript config file that throws during execution', async () => {
    const path = await temporaryConfigFile('release.config.ts', "throw new Error('boom');\n");
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .* could not be loaded/);
  });

  it('rejects a TypeScript config file whose default export fails shape validation', async () => {
    const path = await temporaryConfigFile('release.config.ts', "export default { dryRun: 'not-a-boolean' };\n");
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/"dryRun" must be a boolean/);
  });

  it('rejects an empty config file', async () => {
    const path = await temporaryConfigFile('release.config.json', '');
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/is empty/);
  });

  it('rejects a config file with an unknown option', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ notARealOption: true }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/unknown option/);
  });

  it('reads a commitStrategy of "single"', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ commitStrategy: 'single' }));
    expect((await readReleaseConfigFile(path)).commitStrategy).toBe('single');
  });

  it('leaves commitStrategy undefined when the config file omits it, so releaseWorkspace applies its own "per-package" default', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true }));
    expect((await readReleaseConfigFile(path)).commitStrategy).toBeUndefined();
  });

  it('rejects a commitStrategy that is not "per-package" or "single"', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ commitStrategy: 'per-commit' }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/"commitStrategy" must be one of/);
  });

  it('reads per-package plugin overrides', async () => {
    const path = await temporaryConfigFile(
      'release.config.json',
      JSON.stringify({ packagePlugins: { '@demo/app': ['@semantic-release/npm', ['@semantic-release/git', { assets: ['package.json'] }]] } }),
    );
    expect((await readReleaseConfigFile(path)).packagePlugins).toEqual({ '@demo/app': ['@semantic-release/npm', ['@semantic-release/git', { assets: ['package.json'] }]] });
  });

  it('leaves packagePlugins undefined when the config file omits it, so every package uses the workspace-wide list', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true }));
    expect((await readReleaseConfigFile(path)).packagePlugins).toBeUndefined();
  });

  it('rejects packagePlugins that is not an object of plugin arrays', async () => {
    const notAnObject = await temporaryConfigFile('release.config.json', JSON.stringify({ packagePlugins: ['@semantic-release/npm'] }));
    await expect(readReleaseConfigFile(notAnObject)).rejects.toThrow(/"packagePlugins" must be an object/);

    const notAnArray = await temporaryConfigFile('release.config.json', JSON.stringify({ packagePlugins: { '@demo/app': '@semantic-release/npm' } }));
    await expect(readReleaseConfigFile(notAnArray)).rejects.toThrow(/"packagePlugins" entry for "@demo\/app" must be an array/);

    const badEntry = await temporaryConfigFile('release.config.json', JSON.stringify({ packagePlugins: { '@demo/app': [true] } }));
    await expect(readReleaseConfigFile(badEntry)).rejects.toThrow(/each "packagePlugins" entry must be a module name or a \[name, config\] array/);
  });

  it('rejects a missing config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-cli-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'does-not-exist.json');
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .* could not be loaded/);
  });

  it('reads a gatePublish of true', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ gatePublish: true }));
    expect((await readReleaseConfigFile(path)).gatePublish).toBe(true);
  });

  it('leaves gatePublish undefined when the config file omits it, so releaseWorkspace applies its own "false" default', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true }));
    expect((await readReleaseConfigFile(path)).gatePublish).toBeUndefined();
  });

  it('rejects a gatePublish that is not a boolean', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ gatePublish: 'yes' }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/"gatePublish" must be a boolean/);
  });

  it('reads a tagFormat', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: '${name}-v${version}' }));
    expect((await readReleaseConfigFile(path)).tagFormat).toBe('${name}-v${version}');
  });

  it('leaves tagFormat undefined when the config file omits it, so releaseWorkspace applies its own default template', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ dryRun: true }));
    expect((await readReleaseConfigFile(path)).tagFormat).toBeUndefined();
  });

  it('rejects a tagFormat that is not a string', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: 3 }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/"tagFormat" must be a string/);
  });

  it('rejects a tagFormat without the version placeholder', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: '${name}' }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .*: tagFormat must contain '\$\{version\}'/);
  });

  it('rejects a tagFormat with a placeholder other than name and version', async () => {
    const path = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: '${package}-v${version}' }));
    await expect(readReleaseConfigFile(path)).rejects.toThrow(InvalidArgumentError);
    await expect(readReleaseConfigFile(path)).rejects.toThrow(/--config file .*: tagFormat supports only.*unknown token\(s\): \$\{package\}/);
  });
});

describe('createProgram', () => {
  it('registers --gate-publish and --gate-state-file on the release command', () => {
    const release = createProgram().commands.find((command) => command.name() === 'release');
    expect(release).toBeDefined();
    const optionFlags = (release?.options ?? []).map((option) => option.long);
    expect(optionFlags).toContain('--gate-publish');
    expect(optionFlags).toContain('--gate-state-file');
  });

  it('registers a resume subcommand requiring --gate-state-file', () => {
    const resume = createProgram().commands.find((command) => command.name() === 'resume');
    expect(resume).toBeDefined();
    const gateStateFile = resume?.options.find((option) => option.long === '--gate-state-file');
    expect(gateStateFile).toBeDefined();
    expect(gateStateFile?.mandatory).toBe(true);
    const optionFlags = (resume?.options ?? []).map((option) => option.long);
    expect(optionFlags).toContain('--root');
  });

  it('registers --tag-format on the release command', () => {
    const release = createProgram().commands.find((command) => command.name() === 'release');
    expect((release?.options ?? []).map((option) => option.long)).toContain('--tag-format');
  });

  it('rejects an invalid --tag-format as an invalid argument, before any release work starts', async () => {
    const release = createProgram().commands.find((command) => command.name() === 'release');
    expect(release).toBeDefined();
    release?.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(release?.parseAsync(['--tag-format', '${name}'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.invalidArgument',
      message: expect.stringMatching(/--tag-format.*must contain '\$\{version\}'/) as unknown,
    });
  });
});

const singlePackage: readonly FixturePackage[] = [{ name: '@fixture/a', version: '1.0.0' }];

/** The offline publish pipeline the fixture-backed release tests use, as `--plugin` flag values: the npm plugin still bumps the manifest and the git plugin still commits it, but nothing reaches a registry or GitHub. */
const FIXTURE_PLUGINS: readonly PublishPluginSpec[] = [
  ['@semantic-release/npm', { npmPublish: false }],
  ['@semantic-release/git', { assets: ['package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
];
const FIXTURE_PLUGIN_FLAGS: readonly string[] = FIXTURE_PLUGINS.flatMap((plugin) => ['--plugin', JSON.stringify(plugin)]);

/**
 * Runs the release command through the real command tree in this process. The CLI takes its environment from `process.env`, so the CI-stripped environment the library-level tests pass as an option is applied to `process.env` itself for the duration of the test. Returns every line the command printed.
 */
async function runReleaseCommand(args: readonly string[]): Promise<string[]> {
  const environment = releaseEnv();
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv('CI', 'true');
  const printed: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  await createProgram().parseAsync(['release', ...args], { from: 'user' });
  return printed;
}

describe('release command tag format', () => {
  it('tags a released package in the format a --config file sets', async () => {
    const fixture = await createWorkspaceFixture(singlePackage, [
      { message: 'feat(a): feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ], { tagFormat: '${name}-v${version}' });
    try {
      const config = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: '${name}-v${version}' }));
      const printed = await runReleaseCommand(['--root', fixture.root, '--config', config, ...FIXTURE_PLUGIN_FLAGS]);

      expect(printed).toContain('@fixture/a: @fixture/a-v1.1.0 (minor)');
      const tags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean);
      expect(tags).toContain('@fixture/a-v1.1.0');
      expect(tags).not.toContain('@fixture/a@1.1.0');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('tags a released package in the format --tag-format sets, with no config file', async () => {
    const fixture = await createWorkspaceFixture(singlePackage, [
      { message: 'feat(a): feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ], { tagFormat: '${name}-v${version}' });
    try {
      const printed = await runReleaseCommand([
        '--root', fixture.root, '--tag-format', '${name}-v${version}', ...FIXTURE_PLUGIN_FLAGS,
      ]);

      expect(printed).toContain('@fixture/a: @fixture/a-v1.1.0 (minor)');
      const tags = (await git(['tag', '--list'], { cwd: fixture.root })).split('\n').filter(Boolean);
      expect(tags).toContain('@fixture/a-v1.1.0');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('lets --tag-format override the tagFormat in a --config file', async () => {
    // History carries tags in the flag's format. Were the file's format used instead, semantic-release would find no previous release and report a first release under the file's template.
    const fixture = await createWorkspaceFixture(singlePackage, [
      { message: 'feat(a): feature', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
    ], { tagFormat: '${name}-v${version}' });
    try {
      const config = await temporaryConfigFile('release.config.json', JSON.stringify({ tagFormat: '${name}-from-file-${version}' }));
      const printed = await runReleaseCommand(['--root', fixture.root, '--dry-run', '--config', config, '--tag-format', '${name}-v${version}']);

      expect(printed).toContain('@fixture/a: @fixture/a-v1.1.0 (minor)');
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});
