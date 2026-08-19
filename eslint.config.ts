import js from '@eslint/js';
import exadevRecommendedTypeChecked from '@exadev/eslint-config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // test/smoke.test.mjs spawns the built dist/cli.js, deliberately outside tsconfig's "src" program (it tests build output, not the source).
    ignores: ['dist', 'coverage', 'node_modules', 'test'],
  },
  {
    // Pin the TSConfig root so the parser isn't confused by stray tsconfig.json files elsewhere in the tree. Required because lint-staged runs eslint at commit time.
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  // Bundles typescript-eslint's own recommendedTypeChecked + stylisticTypeChecked, this package's own four exadev/* rules, linterOptions.noInlineConfig, consistent-type-assertions banning all type assertions, and ban-ts-comment banning @ts-expect-error outright alongside the preset's own existing @ts-ignore/@ts-nocheck bans -- see @exadev/eslint-config's own README for the full rule set and rationale.
  ...exadevRecommendedTypeChecked,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // src/index.ts is this package's public entry point (package.json exports); src/cli.ts is the bin entry, a descriptively-named module rather than a second barrel, so 'single' mode (only src/index.ts may be named index.*) applies cleanly to both.
      'exadev/barrel-policy': ['error', { mode: 'single' }],
    },
  },
  {
    // A no-op arrow function is a standard, harmless way to stand in for a callback a given test case never exercises -- flagging every one as an error would just push authors toward padding each with a pointless comment body instead. Scoped to test files only: production code has no legitimate reason for an empty function body.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions', 'asyncFunctions'] }],
    },
  },
);
