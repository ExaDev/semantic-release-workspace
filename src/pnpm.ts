import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PnpmCommandError } from './errors';

const execFileAsync = promisify(execFile);

export interface PnpmCommandOptions {
  readonly cwd: string;
}

/**
 * Regenerates `pnpm-lock.yaml` for the whole workspace from the manifests currently on disk, without touching `node_modules` or installing anything -- the same lockfile-refresh step a contributor runs by hand after editing a `package.json` dependency range.
 *
 * Every dependency-range bump this tool writes to a manifest must be followed by this before the bump is committed: `pnpm install --frozen-lockfile` (what CI runs) rejects a tree where the lockfile's recorded specifier for a workspace dependency disagrees with the manifest, so a manifest bump committed without a matching lockfile update leaves every subsequent CI run broken until someone runs `pnpm install` by hand and commits the result.
 */
export async function regenerateLockfile(options: PnpmCommandOptions): Promise<void> {
  try {
    await execFileAsync('pnpm', ['install', '--lockfile-only'], { cwd: options.cwd });
  } catch (cause) {
    const stderr = cause instanceof Error && 'stderr' in cause && typeof cause.stderr === 'string' ? cause.stderr.trim() : '';
    const detail = stderr !== '' ? stderr : cause instanceof Error ? cause.message : String(cause);
    throw new PnpmCommandError(options.cwd, detail);
  }
}
