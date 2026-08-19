/**
 * Ambient declarations for the two standard plugins this package wraps. Neither @semantic-release/commit-analyzer nor @semantic-release/release-notes-generator ships type declarations and no @types package exists for either, so their documented plugin contract is declared here once: a named export invoked as (pluginConfig, context), returning the determined release type (analyzer, falsy when no release is warranted) or the release-notes markdown (generator). The context types are imported from semantic-release's own declarations rather than mirrored, and the configs are deliberately loose records: this package passes the user's plugin options through verbatim and the plugin itself validates them.
 */
declare module '@semantic-release/commit-analyzer' {
  import type { AnalyzeCommitsContext } from 'semantic-release';

  export type CommitAnalyzerConfig = Record<string, unknown>;
  export function analyzeCommits(pluginConfig: CommitAnalyzerConfig, context: AnalyzeCommitsContext): Promise<string | false | undefined>;
}

declare module '@semantic-release/release-notes-generator' {
  import type { GenerateNotesContext } from 'semantic-release';

  export type ReleaseNotesGeneratorConfig = Record<string, unknown>;
  export function generateNotes(
    pluginConfig: ReleaseNotesGeneratorConfig,
    context: GenerateNotesContext,
  ): Promise<string | false | undefined>;
}
