import { defineConfig } from 'vitest/config';

// The smoke project spawns the real built dist/cli.js as a child process (argv/stdio round trips, not just an in-process import), so it needs more headroom than an in-process unit test.
const UNIT_TEST_TIMEOUT_MS = 10_000;
const SMOKE_TEST_TIMEOUT_MS = 15_000;

// Two named projects, filtered by --project in package.json's scripts: "unit" (src/**/*.test.ts) for pnpm test/test:watch; "smoke" (test/smoke.test.mjs, which spawns dist/cli.js) only ever run by pnpm test:smoke, right after tsdown rebuilds dist/.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // git-workspace-fixture.ts builds the throwaway git workspaces the tests run against. It is test support rather than shipped code (nothing exports it from src/index.ts, so tsdown never bundles it), and counting it as production code would report coverage of the test harness alongside coverage of the library.
      exclude: ['src/**/*.test.ts', 'src/git-workspace-fixture.ts'],
      reporter: ['text', 'html', 'cobertura'],
    },
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], testTimeout: UNIT_TEST_TIMEOUT_MS } },
      { test: { name: 'smoke', include: ['test/smoke.test.mjs'], testTimeout: SMOKE_TEST_TIMEOUT_MS } },
    ],
  },
});
