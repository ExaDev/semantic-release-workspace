import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from './git';
import { createWorkspaceFixture, type FixturePackage } from './git-workspace-fixture';
import { isJsonObject, isUnknownArray } from './json';
import { mustGet } from './graph';
import { createTaggedCommitPublisher } from './recovery-publisher';
import { releaseEnv } from './release-env-fixture';
import { DEFAULT_TAG_FORMAT } from './tag-format';
import { TestTimeoutMs } from './test-timeouts';
import { discoverWorkspace } from './workspace';

interface StepCall {
  readonly step: string;
  readonly label: string;
  readonly cwd: string;
  readonly gitTag: string;
  readonly version: string;
  readonly notes: string;
  readonly source: string;
}

function isStepCalls(value: unknown): value is readonly StepCall[] {
  return (
    isUnknownArray(value) &&
    value.every(
      (entry) =>
        isJsonObject(entry) &&
        ['step', 'label', 'cwd', 'gitTag', 'version', 'notes', 'source'].every((key) => typeof entry[key] === 'string'),
    )
  );
}

/** A plugin defining every step `createTaggedCommitPublisher` calls, recording each call (its own `label` config, the context's working directory and release, and the package's source file as that directory holds it) to a JSON file. */
async function writeStepRecorder(directory: string): Promise<{ readonly modulePath: string; readonly calls: () => Promise<readonly StepCall[]> }> {
  const modulePath = join(directory, 'step-recorder.js');
  const callsFile = join(directory, 'step-recorder-calls.json');
  await writeFile(callsFile, '[]');
  await writeFile(
    modulePath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const CALLS_FILE = ${JSON.stringify(callsFile)};`,
      'function record(step, pluginConfig, context) {',
      '  const calls = JSON.parse(readFileSync(CALLS_FILE, "utf8"));',
      '  const { gitTag, version, notes } = context.nextRelease;',
      '  calls.push({ step, label: pluginConfig.label, cwd: context.cwd, gitTag, version, notes, source: readFileSync(join(context.cwd, "src", "index.js"), "utf8") });',
      '  writeFileSync(CALLS_FILE, JSON.stringify(calls));',
      '}',
      'export async function verifyConditions(pluginConfig, context) { record("verifyConditions", pluginConfig, context); }',
      'export async function publish(pluginConfig, context) { record("publish", pluginConfig, context); return { name: pluginConfig.label }; }',
      'export async function success(pluginConfig, context) { record("success", pluginConfig, context); }',
      '',
    ].join('\n'),
  );
  return {
    modulePath,
    calls: async () => {
      const parsed: unknown = JSON.parse(await readFile(callsFile, 'utf8'));
      if (!isStepCalls(parsed)) {
        throw new Error(`${callsFile} does not hold recorded step calls.`);
      }
      return parsed;
    },
  };
}

const RELEASED: FixturePackage = { name: '@fixture/a', version: '1.0.0', private: false };

describe('createTaggedCommitPublisher', () => {
  it('publishes a tagged release from a checkout of its tagged commit, running the pipeline from the registry step on', async () => {
    const fixture = await createWorkspaceFixture(
      [RELEASED],
      [
        { message: 'feat(a): widen the api', files: { 'packages/a/src/index.js': 'export const a = 2;\n' } },
        {
          message: 'chore(release): @fixture/a@1.1.0 [skip ci]',
          files: { 'packages/a/package.json': `${JSON.stringify({ name: '@fixture/a', version: '1.1.0', private: false, type: 'module' }, null, 2)}\n` },
          tag: '@fixture/a@1.1.0',
        },
        { message: 'feat(a): after the release', files: { 'packages/a/src/index.js': 'export const a = 3;\n' } },
      ],
      { pnpmLockfile: true },
    );
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-step-recorder-'));
    try {
      const recorder = await writeStepRecorder(pluginDirectory);
      const workspace = await discoverWorkspace(fixture.root);
      const pkg = mustGet(new Map(workspace.packages.map((entry) => [entry.name, entry])), '@fixture/a', 'package');
      const publisher = createTaggedCommitPublisher({
        repoRoot: fixture.root,
        env: releaseEnv(),
        log: () => undefined,
        tagFormat: DEFAULT_TAG_FORMAT,
        branches: undefined,
        plugins: new Map([
          [
            '@fixture/a',
            [
              [recorder.modulePath, { label: 'before' }],
              [recorder.modulePath, { label: 'registry' }],
              [recorder.modulePath, { label: 'after' }],
            ],
          ],
        ]),
        registryStep: () => 1,
        generateNotesConfig: {},
        sources: new Map([['@fixture/a', []]]),
      });

      let checkout: string | undefined;
      try {
        await publisher.publish({ pkg, release: { name: '@fixture/a', version: '1.1.0', gitTag: '@fixture/a@1.1.0' } });
        const calls = await recorder.calls();
        checkout = calls[0]?.cwd;

        expect(calls.map((call) => `${call.step}:${call.label}`)).toEqual([
          'verifyConditions:before',
          'verifyConditions:registry',
          'verifyConditions:after',
          'publish:registry',
          'publish:after',
          'success:before',
          'success:registry',
          'success:after',
        ]);
        for (const call of calls) {
          expect(call).toMatchObject({ gitTag: '@fixture/a@1.1.0', version: '1.1.0', source: 'export const a = 2;\n' });
          expect(call.cwd).not.toBe(pkg.directory);
        }
        expect(calls[0]?.notes).toContain('widen the api');
        expect(calls[0]?.notes).not.toContain('after the release');
      } finally {
        await publisher.close();
      }

      if (checkout === undefined) {
        throw new Error('the publisher recorded no call, so there is no checkout to check for removal');
      }
      await expect(access(checkout)).rejects.toThrow();
      const worktrees = (await git(['worktree', 'list', '--porcelain'], { cwd: fixture.root })).split('\n').filter((line) => line.startsWith('worktree '));
      expect(worktrees).toHaveLength(1);
    } finally {
      await rm(pluginDirectory, { recursive: true, force: true });
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);

  it('regenerates the notes of a recovered release over the commits its package sources add', async () => {
    const notesWith = async (sources: readonly string[]): Promise<string> => {
      const fixture = await createWorkspaceFixture(
        [RELEASED],
        [
          { message: 'fix(crate): correct the parser', files: { 'rust/crates/shared/src/lib.rs': 'x\n' } },
          {
            message: 'chore(release): @fixture/a@1.0.1 [skip ci]',
            files: { 'packages/a/package.json': `${JSON.stringify({ name: '@fixture/a', version: '1.0.1', private: false, type: 'module' }, null, 2)}\n` },
            tag: '@fixture/a@1.0.1',
          },
        ],
        { pnpmLockfile: true },
      );
      const pluginDirectory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-step-recorder-'));
      try {
        const recorder = await writeStepRecorder(pluginDirectory);
        const workspace = await discoverWorkspace(fixture.root);
        const pkg = mustGet(new Map(workspace.packages.map((entry) => [entry.name, entry])), '@fixture/a', 'package');
        const publisher = createTaggedCommitPublisher({
          repoRoot: fixture.root,
          env: releaseEnv(),
          log: () => undefined,
          tagFormat: DEFAULT_TAG_FORMAT,
          branches: undefined,
          plugins: new Map([['@fixture/a', [[recorder.modulePath, { label: 'registry' }]]]]),
          registryStep: () => 0,
          generateNotesConfig: {},
          sources: new Map([['@fixture/a', sources]]),
        });
        try {
          await publisher.publish({ pkg, release: { name: '@fixture/a', version: '1.0.1', gitTag: '@fixture/a@1.0.1' } });
          return (await recorder.calls())[0]?.notes ?? '';
        } finally {
          await publisher.close();
        }
      } finally {
        await rm(pluginDirectory, { recursive: true, force: true });
        await fixture.remove();
      }
    };

    expect(await notesWith(['rust/crates/shared'])).toContain('correct the parser');
    expect(await notesWith([])).not.toContain('correct the parser');
  }, TestTimeoutMs.Long);
});
