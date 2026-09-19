import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject, isUnknownArray } from './json';

export interface RecordingPlugin {
  readonly modulePath: string;
  readonly callsFile: string;
}

/**
 * A recording plugin in a directory of its own, outside any git repository, for the tests that need a clean working tree (`commitStrategy: 'single'` refuses to start on a dirty one) and so cannot put the plugin's files inside the fixture workspace. `remove` deletes that directory.
 */
export async function createRecordingPlugin(): Promise<RecordingPlugin & { readonly remove: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-recording-plugin-'));
  const plugin = await writeRecordingPlugin(directory);
  return { ...plugin, remove: async () => rm(directory, { recursive: true, force: true }) };
}

/**
 * A real, resolvable ESM plugin module recording every `publish`/`success` call -- not a mock. `PublishPluginSpec` only accepts a module name or file path (not an inline object the way semantic-release's own engine supports, see `@exadev/release-gate`'s test fixtures for that alternative), so this writes a genuine file `resolvePluginModule` resolves via `require.resolve` on its absolute path. Calls are recorded to a plain JSON file on disk, synchronously, rather than an in-memory module-level array: semantic-release's own plugin loader (`await import(...)` deep inside its own compiled internals) and this test file's own re-import of the same path are two separate module registries under vitest's vite-node runtime, so a shared in-memory array written by one is invisible to the other -- confirmed directly, the array read back was always empty despite the real calls genuinely happening. A file on disk has no such ambiguity, and incidentally matches this feature's own real-world shape better: a resume can genuinely run in a different process from the one that recorded a detach.
 */
export async function writeRecordingPlugin(dir: string): Promise<RecordingPlugin> {
  const modulePath = join(dir, 'recording-plugin.js');
  const callsFile = join(dir, 'recording-plugin-calls.json');
  await writeFile(callsFile, JSON.stringify({ publish: [], success: [] }));
  await writeFile(
    modulePath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const CALLS_FILE = ${JSON.stringify(callsFile)};`,
      'function record(step, entry) {',
      '  const calls = JSON.parse(readFileSync(CALLS_FILE, "utf8"));',
      '  calls[step].push(entry);',
      '  writeFileSync(CALLS_FILE, JSON.stringify(calls));',
      '}',
      'export async function publish(pluginConfig, context) {',
      '  record("publish", { name: context.nextRelease.gitTag, version: context.nextRelease.version });',
      '  return { name: `recorded-${context.nextRelease.version}` };',
      '}',
      'export async function success(pluginConfig, context) {',
      '  record("success", { name: context.nextRelease.gitTag, version: context.nextRelease.version });',
      '}',
      '',
    ].join('\n'),
  );
  return { modulePath, callsFile };
}

export interface RecordedCall {
  readonly name: string;
  readonly version: string;
}

function isRecordedCalls(value: unknown): value is readonly RecordedCall[] {
  return isUnknownArray(value) && value.every((entry) => isJsonObject(entry) && typeof entry.name === 'string' && typeof entry.version === 'string');
}

export async function readRecordingPluginCalls(plugin: RecordingPlugin): Promise<{ readonly publish: readonly RecordedCall[]; readonly success: readonly RecordedCall[] }> {
  const parsed: unknown = JSON.parse(await readFile(plugin.callsFile, 'utf8'));
  if (!isJsonObject(parsed) || !isRecordedCalls(parsed.publish) || !isRecordedCalls(parsed.success)) {
    throw new Error(`${plugin.callsFile} does not contain a valid calls object.`);
  }
  return { publish: parsed.publish, success: parsed.success };
}
