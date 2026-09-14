/**
 * Shared vitest per-test timeout budgets (milliseconds) for this package's fixture-backed integration tests: each spins up a real git repository, a real bare remote, and (for most suites) semantic-release's actual git/npm plugin pipeline, which is slow enough that vitest's default 5-second per-test timeout is never enough.
 */
export const enum TestTimeoutMs {
  /** A full multi-package release run through the real plugin pipeline (per-package or single-commit strategy, with or without gate-publish resume) -- the slowest category. */
  Long = 240_000,
  /** A fixture-backed case that fails fast (a validation error, a cycle check) or exercises only one release before any heavier pipeline work happens, but still pays for fixture setup/teardown. */
  Medium = 60_000,
  /** The fastest fixture-backed cases: workspace fixtures (each its own git init, bare remote, and initial push) with no release pipeline at all. */
  Short = 20_000,
}
