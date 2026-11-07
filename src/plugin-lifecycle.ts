import { pathToFileURL } from 'node:url';
import type { BranchObject, Commit, ReleaseType } from 'semantic-release';
import { ReleaseConfigurationError } from './errors';

/**
 * Calling publish plugins' lifecycle steps directly, outside semantic-release's own `run()`, for the two places that publish an already-tagged release: `commitStrategy: 'single'`'s publish phase (`single-commit-release.ts`), and republishing a tagged release missing from its registry (`recovery-publisher.ts`). semantic-release's `run()` derives the last release from the newest matching tag, so it reads either release as already published.
 */

/** The subset of a semantic-release plugin context the hand-built calls actually construct and pass, covering exactly the fields the `verifyConditions`/`prepare`/`publish`/`success` steps of `@semantic-release/changelog`, `@semantic-release/npm`, and `@semantic-release/github` read (confirmed by reading each plugin's own source), not the full upstream `VerifyReleaseContext` shape, most of which (`envCi`, `branches` plural, `lastRelease`) none of those steps consult. */
export interface PluginCallContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly logger: PluginLogger;
  readonly options: { readonly repositoryUrl: string };
  readonly branch: BranchObject;
  readonly commits: readonly Commit[];
  readonly releases: readonly unknown[];
  readonly nextRelease: {
    readonly type: ReleaseType;
    readonly version: string;
    readonly gitTag: string;
    readonly name: string;
    readonly notes: string;
    readonly channel: string | null;
  };
}

export interface PluginLogger {
  readonly log: (...args: readonly unknown[]) => void;
  readonly warn: (...args: readonly unknown[]) => void;
  readonly error: (...args: readonly unknown[]) => void;
  readonly success: (...args: readonly unknown[]) => void;
}

/** Matches semantic-release's own core exactly (`context.branch.channel || null` in its `index.js`): a branch's `channel` is `string | false | undefined`, and any falsy value (including `false` and an empty string) means "the default channel", represented here as `null`. Written as explicit comparisons rather than `||`/`??` so the falsy-to-null collapse (deliberately including `false` and `''`, which `??` alone would not fold) reads as intentional rather than as a fallback for `undefined`/`null` alone. */
export function channelOrNull(channel: string | false | undefined): string | null {
  return channel === undefined || channel === false || channel === '' ? null : channel;
}

export type ReleaseLifecycleFn = (pluginConfig: Record<string, unknown>, context: PluginCallContext) => Promise<unknown>;

/** The shape of a dynamically-imported publish-plugin module, as far as the callers here call it directly: whichever of these four named exports it happens to define (the same generic, plugin-agnostic dispatch semantic-release's own core uses, which does not hardcode which named plugin defines which step either). */
export interface LoadedReleasePlugin {
  readonly verifyConditions?: ReleaseLifecycleFn;
  readonly prepare?: ReleaseLifecycleFn;
  readonly publish?: ReleaseLifecycleFn;
  readonly success?: ReleaseLifecycleFn;
}

function isReleaseLifecycleFnOrUndefined(value: unknown): value is ReleaseLifecycleFn | undefined {
  return value === undefined || typeof value === 'function';
}

function isReleasePluginModule(value: unknown): value is LoadedReleasePlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if ('verifyConditions' in value && !isReleaseLifecycleFnOrUndefined(value.verifyConditions)) {
    return false;
  }
  if ('prepare' in value && !isReleaseLifecycleFnOrUndefined(value.prepare)) {
    return false;
  }
  if ('publish' in value && !isReleaseLifecycleFnOrUndefined(value.publish)) {
    return false;
  }
  if ('success' in value && !isReleaseLifecycleFnOrUndefined(value.success)) {
    return false;
  }
  return true;
}

/** Loads a publish plugin module directly (bypassing semantic-release's own step-pipeline machinery, which the callers cannot go through: see this file's own top-of-file note), caching by resolved path so a plugin shared by several packages is imported once per run rather than once per package per phase. */
export async function loadReleasePlugin(absolutePath: string, cache: Map<string, LoadedReleasePlugin>): Promise<LoadedReleasePlugin> {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  const loaded: unknown = await import(pathToFileURL(absolutePath).href);
  if (!isReleasePluginModule(loaded)) {
    throw new ReleaseConfigurationError(
      `The publish plugin resolved to ${absolutePath} does not export a recognised semantic-release plugin interface (verifyConditions/prepare/publish/success functions), so its lifecycle steps cannot be called directly to publish an already-tagged release.`,
    );
  }
  cache.set(absolutePath, loaded);
  return loaded;
}

/** A plugin logger prefixing each line with the package it is logging for, so one run's interleaved per-package output stays attributable. */
export function createPluginLogger(name: string, log: (message: string) => void): PluginLogger {
  return {
    log: (...args) => { log(`[${name}] ${args.map(String).join(' ')}`); },
    warn: (...args) => { log(`[${name}] warn: ${args.map(String).join(' ')}`); },
    error: (...args) => { log(`[${name}] error: ${args.map(String).join(' ')}`); },
    success: (...args) => { log(`[${name}] ${args.map(String).join(' ')}`); },
  };
}
