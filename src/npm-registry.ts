import { RegistryQueryError } from './errors';
import { runCommand, type CommandRunner } from './exec-file';
import { isJsonObject } from './json';
import { readManifest } from './manifest';
import type { RegistryClient } from './registry-recovery';

/** The code npm reports when the registry has no such package or no such version of it. */
const NOT_FOUND_CODE = 'E404';

/**
 * Looks published versions up with the npm CLI (`npm view <name>@<version> version --json`), the same client `@semantic-release/npm` publishes with, so the lookup sees what the publish would.
 *
 * Each lookup runs in the package's own directory with `env`, so npm resolves the registry and credentials from the same project configuration and environment variables as the publish; a manifest's `publishConfig.registry`, which `@semantic-release/npm` publishes to ahead of either, is passed as `--registry`. `run` defaults to spawning the real CLI.
 */
export function createNpmRegistryClient(options: { readonly env: NodeJS.ProcessEnv; readonly run?: CommandRunner }): RegistryClient {
  const run = options.run ?? runCommand;
  return {
    async hasVersion(pkg, version) {
      const { publishRegistry } = await readManifest(pkg.manifestPath);
      const args = ['view', `${pkg.name}@${version}`, 'version', '--json', ...(publishRegistry === undefined ? [] : ['--registry', publishRegistry])];
      const result = await run('npm', args, { cwd: pkg.directory, env: options.env });
      const answer = parseAnswer(result.stdout);
      if (result.exitCode === 0 && answer === version) {
        return true;
      }
      if (result.exitCode !== 0 && isJsonObject(answer) && isJsonObject(answer.error) && answer.error.code === NOT_FOUND_CODE) {
        return false;
      }
      throw new RegistryQueryError(
        `npm ${args.join(' ')} in ${pkg.directory} exited ${String(result.exitCode)} without saying whether ${pkg.name}@${version} is published: ${result.stdout.trim()} ${result.stderr.trim()}`,
      );
    },
  };
}

/** npm view's `--json` answer: the version string when it exists, an `{ error: { code } }` object when it does not or the lookup failed. Anything else is left for the caller to reject as unrecognised. */
function parseAnswer(stdout: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch {
    return stdout;
  }
}
