// Smoke test: the real built dist/cli.js runs correctly as a genuine subprocess -- argv parsing and exit codes, not just the in-process command tree. Run only via `pnpm test:smoke` (tsdown, then vitest scoped to the "smoke" project), never part of the default `pnpm test` file set, since it requires a fresh build to mean anything. Spawns dist/cli.js with node:child_process rather than importing it (a bin script is not designed to be imported) or calling src/cli.ts's createProgram() directly (that would exercise the in-process command tree, not the actual shipped CLI's argv/exit-code/stdio behaviour this file exists to prove).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const EXIT_SUCCESS = 0;

// Spawns `node dist/cli.js <args>` as a real child process (via process.execPath rather than relying on the shebang/chmod bit, so this doesn't depend on the host OS honouring executable permissions), collects stdout as text, and resolves once the process exits.
function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout: Buffer.concat(stdoutChunks).toString('utf8') });
    });
  });
}

describe('dist/cli.js --version', () => {
  it('exits 0 and prints a real version string', async () => {
    const { code, stdout } = await spawnCli(['--version']);
    expect(code).toBe(EXIT_SUCCESS);
    // Not a fixed literal -- semantic-release rewrites package.json's version at release time, so only the shape is checked, not a specific value.
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('dist/cli.js --help', () => {
  it('exits 0 and prints the program description', async () => {
    const { code, stdout } = await spawnCli(['--help']);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout).toContain('semantic-release orchestration');
  });
});
