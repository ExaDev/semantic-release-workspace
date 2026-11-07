import { spawn } from 'node:child_process';
import { PnpmCommandError } from './errors';
import { execFile } from './exec-file';

export interface PnpmCommandOptions {
  readonly cwd: string;
}

/**
 * Regenerates `pnpm-lock.yaml` for the whole workspace from the manifests currently on disk, without touching `node_modules` or installing anything -- the same lockfile-refresh step a contributor runs by hand after editing a `package.json` dependency range.
 *
 * Every dependency-range bump this tool writes to a manifest must be followed by this before the bump is committed: `pnpm install --frozen-lockfile` (what CI runs) rejects a tree where the lockfile's recorded specifier for a workspace dependency disagrees with the manifest, so a manifest bump committed without a matching lockfile update leaves every subsequent CI run broken until someone runs `pnpm install` by hand and commits the result.
 */
export async function regenerateLockfile(options: PnpmCommandOptions): Promise<void> {
  const args = ['install', '--lockfile-only'];
  try {
    await execFile('pnpm', args, { cwd: options.cwd });
  } catch (cause) {
    const stderr = cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string' ? cause.stderr.trim() : '';
    const detail = stderr !== '' ? stderr : cause instanceof Error ? cause.message : String(cause);
    throw new PnpmCommandError(args, options.cwd, detail);
  }
}

/**
 * Installs the workspace at `cwd` exactly as its committed lockfile records it (`pnpm install --frozen-lockfile`), as a release job does before it releases, so a checkout of a tagged commit can build and publish the way that commit's own release would have. pnpm's output goes straight to this process's own output, where a CI log shows it, rather than being buffered.
 */
export async function installFrozenLockfile(options: PnpmCommandOptions & { readonly env: NodeJS.ProcessEnv }): Promise<void> {
  const args = ['install', '--frozen-lockfile'];
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('pnpm', args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode !== 0) {
    throw new PnpmCommandError(args, options.cwd, exitCode === null ? 'terminated by a signal' : `exit ${String(exitCode)}; its output is above`);
  }
}
