/**
 * @exadev/semantic-release-workspace -- independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.
 *
 * The public programmatic surface: discover a workspace and its inter-package dependency graph, order it topologically, rewrite dependency ranges when a sibling releases, and drive the whole release run. `releaseWorkspace` composes all of it; the individual pieces are exported so an embedder can inspect or reuse any stage.
 */

export { packageName } from './package-name';

export { discoverWorkspace, type Workspace, type WorkspacePackage } from './workspace';
export { buildDependencyGraph, topologicalOrder, type DependencyGraph, type WorkspaceDependency } from './graph';
export { classifyDependencyRange, updateDependencyRange, type DependencyRangeShape, type DependencyRangeUpdate } from './version-range';
export { readManifest, writeDependencyRange, type DependencyField, type PackageManifest } from './manifest';

export {
  createScopedPlugins,
  filterCommitsToDirectory,
  resolvePublishPlugins,
  DEFAULT_PUBLISH_PLUGINS,
  type DependencyBump,
  type DependencyBumpSource,
  type PublishPluginSpec,
  type ResolvedPublishPlugin,
  type ScopedPlugins,
} from './plugins';
export {
  releaseWorkspace,
  type ReleaseWorkspaceOptions,
  type WorkspaceReleaseOutcome,
  type PackageReleaseOutcome,
  type AppliedDependencyBump,
} from './release';

export {
  WorkspaceReleaseError,
  WorkspaceDiscoveryError,
  DependencyCycleError,
  UnsupportedDependencyRangeError,
  ReleaseConfigurationError,
  GitCommandError,
  WorkspaceStateError,
} from './errors';
