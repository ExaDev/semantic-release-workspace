/** A parsed JSON object. `JSON.parse` returns `any`, so every value read out of one is narrowed through the guards below rather than asserted. */
export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Narrows `unknown` to `unknown[]`. `Array.isArray` alone narrows to `any[]`, whose elements flow as `any` into any later destructuring; going through this guard keeps the elements `unknown` so they must still be narrowed by hand.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * The indentation of the first indented line in a JSON document, so a rewritten manifest keeps the formatting the repository already uses instead of being reflowed to whatever `JSON.stringify` defaults to. A file with no indented line at all (`{}` on one line) has no evidence either way, in which case two spaces -- npm's own default when it writes a `package.json` -- is the closest thing to a neutral choice.
 */
const FIRST_INDENTED_LINE = /^[ \t]+(?=")/m;
const NPM_DEFAULT_INDENT = '  ';

export function detectIndent(text: string): string {
  const match = FIRST_INDENTED_LINE.exec(text);
  return match === null ? NPM_DEFAULT_INDENT : match[0];
}

/** Serialises a JSON document back to text with the indentation and trailing-newline convention of the text it was read from, so rewriting one dependency range produces a one-line diff rather than a whole-file reformat. */
export function stringifyJsonLike(value: JsonObject, originalText: string): string {
  const serialised = JSON.stringify(value, null, detectIndent(originalText));
  return originalText.endsWith('\n') ? `${serialised}\n` : serialised;
}
