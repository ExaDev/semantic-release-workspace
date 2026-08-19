/**
 * @exadev/semantic-release-workspace -- independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.
 *
 * The public programmatic entry point. The orchestration API (workspace discovery, per-package release-eligibility analysis, and the driver that invokes semantic-release per package) lands here in a follow-up change; this barrel re-exports the one placeholder module that exists now so the package's build, lint, and publish pipeline has a real entry point to exercise.
 */

export { packageName } from './package-name';
