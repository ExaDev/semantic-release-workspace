import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from './exec-file';
import { createWorkspaceFixture } from './git-workspace-fixture';
import { releaseWorkspace } from './release';
import { releaseEnv } from './release-env-fixture';
import { TestTimeoutMs } from './test-timeouts';

const EXECUTABLE = 0o755;

/** Runs `run` with a `git` first on PATH that appends each invocation's arguments to a file, and returns every recorded invocation. */
async function recordGitInvocations(run: () => Promise<void>): Promise<readonly string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-git-calls-'));
  try {
    const { stdout } = await execFile('sh', ['-c', 'command -v git'], { cwd: directory });
    const realGit = stdout.trim();
    const log = join(directory, 'calls.log');
    await writeFile(log, '');
    const wrapper = join(directory, 'git');
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(wrapper, EXECUTABLE);
    vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
    await run();
    return (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('git invocations of a run without packageSources', () => {
  it('discovers the workspace once for recovery and once for the release, and runs no pathspec query', async () => {
    const fixture = await createWorkspaceFixture([{ name: '@fixture/a', version: '1.0.0' }], []);
    try {
      const calls = await recordGitInvocations(async () => {
        await releaseWorkspace({ root: fixture.root, env: releaseEnv(), dryRun: true, plugins: [] });
      });
      expect(calls.filter((call) => call === 'rev-parse --show-prefix')).toHaveLength(2);
      expect(calls.filter((call) => call.startsWith('ls-files'))).toEqual([]);
      expect(calls.filter((call) => call.includes(':(top,glob)'))).toEqual([]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Long);
});
