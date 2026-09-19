import { ReleaseConfigurationError } from './errors';

/**
 * The default per-package tag template: npm-dist-tag style `name@version`, which keeps every package's release tags distinct and greppable in the one shared tag namespace.
 */
export const DEFAULT_TAG_FORMAT = '${name}@${version}';

/**
 * Validate a caller-supplied tagFormat once per run, before any package releases. The template must contain `${version}` (semantic-release interpolates it; without it every package would compute the same tag and overwrite its predecessor) and may contain `${name}`, which the orchestrator substitutes per package. Any other `${...}` token is a typo or a placeholder semantic-release does not support in tagFormat, so it is rejected here rather than released as a literal into a tag name.
 */
export function validateTagFormat(tagFormat: string): string {
  if (!tagFormat.includes('${version}')) {
    throw new ReleaseConfigurationError(
      `tagFormat must contain '\${version}' so each package's release tag carries its version; got: ${tagFormat}`,
    );
  }
  const unknown = [...tagFormat.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? '').filter((token) => token !== 'name' && token !== 'version').filter((token) => token !== '');
  if (unknown.length > 0) {
    throw new ReleaseConfigurationError(
      `tagFormat supports only the '\${name}' and '\${version}' placeholders; unknown token(s): ${unknown.map((token) => `\${${token}}`).join(', ')}`,
    );
  }
  return tagFormat;
}

/**
 * Substitute `${name}` for one package. Called per package at release time; the returned template still carries the literal `${version}` for semantic-release to interpolate, exactly as the default `name@version` format always has.
 */
export function formatTagForPackage(tagFormat: string, name: string): string {
  return tagFormat.replaceAll('${name}', name);
}
