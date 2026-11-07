import { RegistryQueryError } from './errors';
import { runCommand, type CommandRunner } from './exec-file';
import { isJsonObject } from './json';
import { readManifest } from './manifest';
import type { RegistryClient } from './registry-recovery';

/** The code npm reports when the registry has no such package or no such version of it. */
const NOT_FOUND_CODE = 'E404';

/** The stderr line every npm major prints for a failed command, naming its error code. */
const STDERR_ERROR_CODE = /^npm error code (\S+)$/m;

/**
 * Looks published versions up with the npm CLI (`npm view <name>@<version> version --json`), the same client `@semantic-release/npm` publishes with, so the lookup sees what the publish would.
 *
 * Each lookup runs in the package's own directory with `env`, so npm resolves the registry and credentials from the same project configuration and environment variables as the publish; a manifest's `publishConfig.registry`, which `@semantic-release/npm` publishes to ahead of either, is passed as `--registry`. `run` defaults to spawning the real CLI.
 *
 * A published version is answered as the version string (npm 11) or a list of the matching versions (npm 12), and counts only when the answer names this exact version. A missing package or version is an E404, read from the JSON error object npm prints on stdout or, failing that, the `npm error code` line on stderr. Every other answer rejects with `RegistryQueryError`, since whether the version is published is then unknown.
 */
export function createNpmRegistryClient(options: { readonly env: NodeJS.ProcessEnv; readonly run?: CommandRunner }): RegistryClient {
  const run = options.run ?? runCommand;
  return {
    async hasVersion(pkg, version) {
      const { publishRegistry } = await readManifest(pkg.manifestPath);
      const args = ['view', `${pkg.name}@${version}`, 'version', '--json', ...(publishRegistry === undefined ? [] : ['--registry', publishRegistry])];
      const result = await run('npm', args, { cwd: pkg.directory, env: options.env });
      const answer = parseAnswer(result.stdout);
      if (result.exitCode === 0 && namesVersion(answer, version)) {
        return true;
      }
      if (result.exitCode !== 0 && errorCode(answer, result.stderr) === NOT_FOUND_CODE) {
        return false;
      }
      throw new RegistryQueryError(
        `npm ${args.join(' ')} in ${pkg.directory} exited ${String(result.exitCode)} without saying whether ${pkg.name}@${version} is published; its output parsed as ${JSON.stringify(answer)}${result.stderr.trim() === '' ? '' : `, stderr: ${result.stderr.trim()}`}`,
      );
    },
  };
}

/** Whether a successful answer names `version`: the version itself (npm 11), or a list holding it (npm 12, which lists every version matching the spec). */
function namesVersion(answer: unknown, version: string): boolean {
  return answer === version || (Array.isArray(answer) && answer.includes(version));
}

/** The npm error code of a failed lookup: from the JSON error object on stdout, else from stderr's `npm error code` line. */
function errorCode(answer: unknown, stderr: string): string | undefined {
  if (isJsonObject(answer) && isJsonObject(answer.error) && typeof answer.error.code === 'string') {
    return answer.error.code;
  }
  return STDERR_ERROR_CODE.exec(stderr)?.[1];
}

/** npm view's `--json` answer parsed, or the raw text when it is not JSON (an empty answer included), for the caller to reject as unrecognised. */
function parseAnswer(stdout: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch {
    return stdout;
  }
}
