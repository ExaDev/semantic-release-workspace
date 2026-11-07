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
      if (result.exitCode === 0) {
        // npm releases before 11 print nothing, and exit 0, for a version a published package does not have.
        return answer === undefined ? false : answer === version;
      }
      if (isJsonObject(answer) && isJsonObject(answer.error) && answer.error.code === NOT_FOUND_CODE) {
        return false;
      }
      throw new RegistryQueryError(`npm ${args.join(' ')} failed in ${pkg.directory} (exit ${String(result.exitCode)}), so whether ${pkg.name}@${version} is published is unknown: ${result.stderr.trim()}`);
    },
  };
}

function parseAnswer(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    throw new RegistryQueryError(`npm view printed something other than JSON: ${trimmed}`);
  }
}
