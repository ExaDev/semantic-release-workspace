import { execFile as execFileCallback, type ExecException } from 'node:child_process';

export interface ExecFileResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecFileOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

/**
 * A hand-written promise wrapper around `child_process.execFile`, in place of `util.promisify(execFile)`: `execFile` synchronously returns a `ChildProcess` in addition to invoking its callback, which trips `@typescript-eslint/strict-void-return` when the whole function is handed to `promisify` (a value-returning function used where a void-returning one is contextually expected there) -- exactly the void-return contravariance leniency that rule exists to catch, even though `tsc` itself accepts the pattern. Calling `execFile` directly with our own callback, whose own return type really is `void`, sidesteps the mismatch instead of suppressing it.
 */
export async function execFile(command: string, args: readonly string[], options: ExecFileOptions): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: options.maxBuffer }, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        // `ExecException` is a plain interface (`extends Error`), not the `Error` class itself, so type-directed lint checks that look for the built-in `Error` symbol specifically don't recognise it as error-like on its own -- narrowing through `instanceof Error` (always true for a real exec failure at runtime) satisfies that check honestly rather than suppressing it.
        reject(error instanceof Error ? error : new Error(error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** A finished command's exit code and output. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command and resolves with its exit code and output whatever the exit code, for a caller that reads its answer from a failing exit too (`npm view` reports a missing version as an error). */
export type CommandRunner = (command: string, args: readonly string[], options: ExecFileOptions) => Promise<CommandResult>;

/**
 * The real `CommandRunner`. Rejects only when the command produced no exit code at all (it could not be started, or a signal killed it), since then there is no answer to read.
 */
export async function runCommand(command: string, args: readonly string[], options: ExecFileOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: options.maxBuffer }, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      reject(error instanceof Error ? error : new Error(error.message));
    });
  });
}
