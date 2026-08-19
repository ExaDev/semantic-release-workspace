import { describe, expect, it } from 'vitest';
import { detectIndent, stringifyJsonLike } from './json';

describe('stringifyJsonLike', () => {
  it('preserves two-space indentation and a trailing newline', () => {
    const text = '{\n  "name": "a",\n  "version": "1.0.0"\n}\n';
    expect(stringifyJsonLike({ name: 'a', version: '1.2.0' }, text)).toBe('{\n  "name": "a",\n  "version": "1.2.0"\n}\n');
  });

  it('preserves tab indentation and the absence of a trailing newline', () => {
    const text = '{\n\t"name": "a"\n}';
    expect(stringifyJsonLike({ name: 'b' }, text)).toBe('{\n\t"name": "b"\n}');
  });

  it('falls back to npm\'s two-space default for a file with no indented line to detect from', () => {
    expect(stringifyJsonLike({ name: 'a' }, '{}')).toBe('{\n  "name": "a"\n}');
  });
});

describe('detectIndent', () => {
  it('finds the first indented line', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe('    ');
  });
});
