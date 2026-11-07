import { UnpublishedReleaseRecoveryError, type UnrecoveredRelease } from './errors';
import { mustGet, type DependencyGraph } from './graph';
import type { WorkspacePackage } from './workspace';

/** A package's release as its git tag records it. */
export interface TaggedRelease {
  readonly name: string;
  readonly version: string;
  readonly gitTag: string;
}

/** Where a package's highest released version is read from: its release tags. */
export interface ReleasedTagSource {
  /** The highest version released from this branch for `pkg`, or `undefined` when it has never released. */
  latestRelease: (pkg: WorkspacePackage) => Promise<Omit<TaggedRelease, 'name'> | undefined>;
}

/** Where a published version is looked up. */
export interface RegistryClient {
  /** Whether `pkg`'s registry holds `version`. Resolves `false` only when the registry answers that the version (or the whole package) does not exist; any other failure rejects, since the answer is then unknown. */
  hasVersion: (pkg: WorkspacePackage, version: string) => Promise<boolean>;
}

/** A tagged release whose version its registry does not hold. */
export interface RecoveryCandidate {
  readonly pkg: WorkspacePackage;
  readonly release: TaggedRelease;
}

/** Publishes one tagged release from the commit its tag names. Rejects when the publish fails; the rejection's message is what the run reports. */
export interface RecoveryPublisher {
  publish: (candidate: RecoveryCandidate) => Promise<void>;
}

/**
 * npm's own wording when a registry refuses a version it already holds (the registry's 403 body, which npm prints after `code E403`). Matched on the wording rather than the code because an E403 also means a missing permission, which is a real failure.
 */
const VERSION_ALREADY_PUBLISHED = /\bE403\b[\s\S]*cannot publish over the previously published version/i;

/** Whether a publish failure says the registry already holds the version, which is the state recovery exists to reach. */
export function isVersionAlreadyPublished(cause: unknown): boolean {
  return cause instanceof Error && VERSION_ALREADY_PUBLISHED.test(cause.message);
}

/**
 * Publishes every release whose tag exists but whose version its registry does not hold.
 *
 * A release is tagged and pushed before its publish plugins run, under both commit strategies, so a publish that fails after tagging (a registry or signing outage, a cancelled job) leaves a tag that every later run reads as already released. Releases are derived from tags, so nothing would ever publish that version. This pass compares each publishing package's highest release tag with its registry and publishes the missing versions from their tagged commits.
 *
 * Candidates are published in `order` (topological), so a package's workspace dependencies reach the registry before it does. When one fails, every candidate that depends on it, directly or through other workspace packages, is left unpublished, since its published manifest would name a version consumers cannot install; independent candidates still publish. Any failure rejects with `UnpublishedReleaseRecoveryError` once every candidate has been tried, so the caller releases nothing new and the next run retries. A publish the registry refuses because it already holds the version counts as done.
 *
 * `publishes` says whether a package publishes to a registry at all; a package that does not is never looked up. A dry run looks the versions up and reports what it would publish, publishing nothing. Returns the releases published, or in a dry run the releases that would be.
 */
export async function recoverUnpublishedReleases(
  input: {
    readonly graph: DependencyGraph;
    readonly order: readonly string[];
    readonly publishes: (pkg: WorkspacePackage) => boolean;
    readonly dryRun: boolean;
    readonly log: (message: string) => void;
    /** Called as each release is published, so a caller can record it even when a later one fails. Not called in a dry run. */
    readonly onRecovered?: (release: TaggedRelease) => void;
  },
  dependencies: { readonly tags: ReleasedTagSource; readonly registry: RegistryClient; readonly publisher: RecoveryPublisher },
): Promise<readonly TaggedRelease[]> {
  const { graph, order, log } = input;
  const recovered: TaggedRelease[] = [];
  const failed: UnrecoveredRelease[] = [];
  const blocked: UnrecoveredRelease[] = [];
  // Every package that must not publish because something it depends on is missing from the registry, mapped to the failed release that caused it.
  const blockedBy = new Map<string, string>();

  for (const name of order) {
    const pkg = mustGet(graph.packages, name, 'package');
    if (!input.publishes(pkg)) {
      continue;
    }
    const latest = await dependencies.tags.latestRelease(pkg);
    if (latest === undefined) {
      continue;
    }
    const release: TaggedRelease = { name, ...latest };
    if (await dependencies.registry.hasVersion(pkg, release.version)) {
      continue;
    }

    const cause = blockedBy.get(name);
    if (cause !== undefined) {
      blocked.push({ name, gitTag: release.gitTag, reason: `not published, because it depends on ${cause}, which could not be published` });
      log(`${name}: ${release.gitTag} is tagged but missing from the registry; not republishing it, because it depends on ${cause}, which could not be published`);
      continue;
    }

    if (input.dryRun) {
      log(`${name}: ${release.gitTag} is tagged but missing from the registry; would republish it from its tag`);
      recovered.push(release);
      continue;
    }

    log(`${name}: ${release.gitTag} is tagged but missing from the registry; republishing it from its tag`);
    try {
      await dependencies.publisher.publish({ pkg, release });
    } catch (error) {
      if (isVersionAlreadyPublished(error)) {
        log(`${name}: the registry already holds ${release.gitTag}; nothing to republish`);
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ name, gitTag: release.gitTag, reason });
      log(`${name}: republishing ${release.gitTag} failed: ${reason}`);
      for (const dependent of transitiveDependents(graph, name)) {
        if (!blockedBy.has(dependent)) {
          blockedBy.set(dependent, release.gitTag);
        }
      }
      continue;
    }
    log(`${name}: republished ${release.gitTag}`);
    recovered.push(release);
    input.onRecovered?.(release);
  }

  if (failed.length > 0) {
    throw new UnpublishedReleaseRecoveryError(failed, blocked, recovered);
  }
  return recovered;
}

/** Every package that depends on `name` through any chain of workspace dependency edges, in any field. */
function transitiveDependents(graph: DependencyGraph, name: string): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const edge of mustGet(graph.dependents, next, 'dependents')) {
      if (!found.has(edge.dependent)) {
        found.add(edge.dependent);
        pending.push(edge.dependent);
      }
    }
  }
  return found;
}
