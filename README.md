# semantic-release-workspace

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/semantic-release-workspace) [![npm](https://img.shields.io/badge/npm-CB3833?logo=npm&logoColor=white)](https://www.npmjs.com/package/@exadev/semantic-release-workspace) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/semantic-release-workspace/ci.yml?branch=main)](https://github.com/ExaDev/semantic-release-workspace/actions)

> Independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.

A pnpm workspace publishing every package under one shared version number (lockstep) forces an unrelated package to release whenever any sibling changes. This tool runs semantic-release independently per package, driven by each package's own commit history and its own dependencies within the workspace, so a change to one package never forces a version bump in another — while a package whose dependencies genuinely changed still releases, so no published manifest ever disagrees with the repository.

Built for the [documents.js ecosystem's monorepo consolidation](https://github.com/ExaDev/documents.js/issues/664) and reusable from any pnpm workspace: it discovers packages from `pnpm-workspace.yaml` and their manifests, with nothing hardcoded about any particular ecosystem layout.

## How it works

One orchestrator run, five stages:

1. **Workspace discovery.** Reads the `packages` globs from `pnpm-workspace.yaml` and every matched package's `package.json` (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`), building the inter-package dependency graph keyed by package name. Packages must live in subdirectories (a package at the workspace root touches every commit and cannot be path-scoped) and names must be unique.
2. **Topological release ordering.** Kahn's algorithm over the discovered graph, so a package only releases after every workspace sibling it depends on has already released in this run. Ties are broken alphabetically within each dependency layer, so the same workspace always produces the same order. A dependency cycle has no valid order at all — the run fails loudly, naming the loop (`x -> y -> x`), rather than picking one of the wrong answers and publishing a package whose sibling dependency points at a version that does not exist yet.
3. **Per-package scoped release.** For each package in order, the orchestrator calls semantic-release's programmatic API (`require('semantic-release')`, not the CLI) with `cwd` set to the package's directory, `tagFormat` set to `name@version` so each package's tags stay distinct in the one shared tag namespace, and inline `analyzeCommits`/`generateNotes` plugins. Each wrapper runs one `git log --name-only --no-renames` pass over the same release range semantic-release already analysed (from the package's last matching tag to `HEAD`, or the whole history for a first release), maps every commit to the paths it changed, and filters the commit list down to commits touching the package's own directory **before delegating to the real @semantic-release/commit-analyzer and @semantic-release/release-notes-generator**. Conventional-commit parsing and changelog formatting stay entirely inside the standard plugins — the orchestrator only scopes what they see.
4. **Cross-package manifest bumping** — the heart of the design, covered in its own section below.
5. **Standard plugins do the publishing.** @semantic-release/npm, @semantic-release/github, @semantic-release/changelog, and @semantic-release/git run per package exactly as in a single-package repository, scoped by `cwd`. The orchestrator coordinates and sequences them; it does not reimplement npm publishing, GitHub release creation, or changelog file writing.

## The manifest-bump timing decision

When a package releases version `V`, every *not-yet-released-this-run* workspace package that depends on it gets its dependency range updated — and the timing of that update is the least obvious part of the whole design, because getting it wrong is exactly the bug class the documents.js ecosystem's old cross-repo automation hit (the `sibling-dependency-update` heal-job downgrade race: repository state and published manifests disagreeing, then automation "healing" in the wrong direction; see [documents.js#664](https://github.com/ExaDev/documents.js/issues/664)).

The orchestrator's rule: **the moment a package's release completes, each dependent's manifest is rewritten on disk, committed, and pushed — before anything else happens.** A bump commit looks like:

```
chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]
```

Why commit immediately, rather than the alternatives:

- **Why commit at all (not just edit the working tree)?** A dependent's semantic-release run analyses *git history*, not the working tree. An uncommitted manifest edit is invisible to its commit analysis, so the dependent could be judged "no changes" and skip a release — leaving a manifest that names a version the registry has, but which the dependent never published, stranded uncommitted in one developer's checkout.
- **Why before the dependent's own run (not after)?** The dependent's release commit and its published artifact must carry the new range. Bumping after would publish the dependent with a stale range, then mutate the repository afterwards — the repository/published-artifact disagreement this tool exists to prevent.
- **Why push immediately?** The same crash-consistency discipline semantic-release applies to its own release commits: if the orchestrator dies halfway through the run, everything pushed so far (releases, tags, bump commits) is a consistent prefix, and the next run picks up cleanly from the tags. `[skip ci]` on the bump message stops the push from triggering a *second*, racing release run.

Because every dependent sits downstream in topological order, its own run always sees the bump commit: the commit touches only the dependent's directory, so it passes that dependent's path filter and participates in its analysis.

**A package whose only change is dependency bumps still gets a patch release — deliberately.** Whether the range was rewritten on disk (`^1.0.0` → `^1.1.0`) or is a `workspace:^`-style range that pnpm re-resolves at pack time, the dependent's *published* dependency range changes, so the dependent must be republished for the change to reach consumers. This is not left to chance: the wrapped `analyzeCommits` returns `patch` whenever the standard analyzer found nothing but this run bumped one of the package's dependency ranges, so the behaviour does not depend on how the workspace's own analyzer config happens to classify `chore(deps)` commits (many presets release nothing for `chore`). Release notes gain a `### Dependencies` section listing the bumps, so the release is self-explaining rather than empty.

Dependency-range handling, in full:

| Range in the dependent's manifest | What happens |
| --- | --- |
| `^1.0.0`, `~1.0.0`, `>=1.0.0`, `=1.0.0`, `1.0.0`, `workspace:^1.0.0` | Rewritten in place, preserving the comparator (`^1.0.0` → `^1.1.0`), committed and pushed; dependent gets at least a patch release |
| `workspace:*`, `workspace:^`, `workspace:~` | No manifest edit (pnpm resolves these at pack time), but the published range still changes, so the dependent still gets a patch release |
| `*`, `x`, `latest` | Nothing to update and the published range is unaffected — no bump, no forced release |
| Compound ranges (`>=1.0.0 <2.0.0`), unions (`1.x \|\| 2.x`), `<`/`<=` bounds, `catalog:`, `npm:` aliases, git/tarball URLs | The run stops with `UnsupportedDependencyRangeError` — rewriting any of these wrongly, or leaving them silently stale, both produce a published manifest that disagrees with the repository, so neither is attempted |

For that reason concrete ranges (which the orchestrator maintains for you) are the recommended mode. Publishing `workspace:` ranges correctly additionally requires a pack step that substitutes them, as `pnpm publish` does.

## Relationship to @qiwi/multi-semantic-release

This tool exists because of [documents.js#664](https://github.com/ExaDev/documents.js/issues/664)'s research, which compared the third-party landscape — [@qiwi/multi-semantic-release](https://github.com/qiwi/multi-semantic-release) (itself a fork of [dhoulb's original](https://github.com/dhoulb/multi-semantic-release)), its successor [bulk-release](https://www.npmjs.com/package/bulk-release), and [Changesets](https://github.com/changesets/changesets) — against building in-house, and chose in-house: the org already maintains shared tooling config in exactly this shape, semantic-release's plugin lifecycle is well documented rather than proprietary, and the failure modes specific to cross-package version propagation were already understood from operating the ecosystem's existing automation ([background reading](https://dev.to/antongolub/the-chronicles-of-semantic-release-and-monorepos-5cfc)).

The core technique is the same one multi-semantic-release proved in production: per-package semantic-release with a `name@version` tag format and commit lists path-filtered to the package's directory. The differences are deliberate:

- **In-process delegation, not CLI wrapping.** semantic-release is invoked through its programmatic API with inline plugin functions, so the wrappers delegate to the real @semantic-release/commit-analyzer and @semantic-release/release-notes-generator running in the same process. (The analysed plugins are ESM named exports here, resolved as peers of this package — no plugin re-implementation anywhere.)
- **Bump-only dependents always release.** multi-semantic-release rewrites dependency ranges in the working tree without committing them, so a dependent whose only change is a dependency update can go unreleased until some other commit triggers it. Here the bump is committed before the dependent's turn and a patch release is forced deterministically (see the timing section above).
- **Loud failures by design.** A dependency cycle, an unsupported dependency range, a publish pipeline without @semantic-release/git (which would leave released manifests uncommitted), an unresolvable plugin, a duplicate package name — each stops the run with a specific error rather than degrading silently. There is deliberately no "skip this package and carry on" path: a partially-consistent set of publishes is worse than none.
- **pnpm-native range semantics.** `workspace:*`/`workspace:^`/`workspace:~` are understood as publish-resolved (bump the release, not the manifest text); `catalog:` and `npm:` aliases are rejected with an explanation instead of being mangled.
- **Workspace-agnostic discovery.** Everything comes from `pnpm-workspace.yaml` and the manifests its globs match; pointing the orchestrator at any pnpm workspace is the entire configuration.

Out of scope, on purpose: parallelising independent branches of the dependency graph (packages release sequentially in topological order for correctness first — a real future optimisation, not attempted here), and any Changesets-style explicit-changeset mode, which is a different paradigm rather than a missing feature.

## Usage

### As a CLI step in a release workflow

Install once at the workspace root (the six standard plugins are peer dependencies and must be installed alongside):

```sh
pnpm add -D semantic-release-workspace semantic-release @semantic-release/commit-analyzer @semantic-release/release-notes-generator @semantic-release/changelog @semantic-release/npm @semantic-release/github @semantic-release/git
```

Then one step replaces the per-repo release job. In GitHub Actions (this package's own OIDC trusted-publishing pattern carries over unchanged — publishing credentials stay between semantic-release's plugins and the registry):

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec semantic-release-workspace release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_CONFIG_PROVENANCE: 'true'
```

Run it from the workspace root (or pass `--root <directory>`). A dry run analyses and reports every package's would-be release, including the dependency-bump cascade, without publishing, tagging, committing, or pushing — useful locally, where semantic-release would otherwise force dry-run mode anyway outside CI.

### CLI options

| Option | Meaning |
| --- | --- |
| `--root <directory>` | Workspace root holding `pnpm-workspace.yaml` (default: the process working directory) |
| `--dry-run` | Analyse and report only |
| `--branches <branch>` | Release branch for semantic-release; repeat for multiple branches (default: semantic-release's own default branch list) |
| `--plugin <spec>` | Publish-pipeline plugin, repeatable — a module name (`@semantic-release/github`) or a JSON tuple (`'["@semantic-release/git",{"assets":["package.json"]}]'`); defaults to the standard changelog/npm/github/git pipeline |
| `--analyze-commits <json>` | Options for the wrapped @semantic-release/commit-analyzer (e.g. `'{"preset":"conventionalcommits","releaseRules":[...]}'`) |
| `--generate-notes <json>` | Options for the wrapped @semantic-release/release-notes-generator |
| `--config <file>` | A JSON file providing any of the above; explicit flags win |

Listing `@semantic-release/commit-analyzer` or `@semantic-release/release-notes-generator` as a `--plugin` is rejected: the orchestrator always provides those two steps itself (wrapped), so configuring them there would be a silent no-op — pass their options via `--analyze-commits`/`--generate-notes` instead. A real (non-dry) run must include `@semantic-release/git` in the pipeline, because without it nothing commits released manifests and changelogs back to the branch.

Note that the orchestrator sets `tagFormat`, `plugins`, `analyzeCommits`, and `generateNotes` explicitly on every per-package run, so those keys in any `release.config.*` found in the workspace are overridden by construction — configure the release through the orchestrator, not through a leftover single-package config.

### Programmatic API

```ts
import { releaseWorkspace } from '@exadev/semantic-release-workspace';

const outcome = await releaseWorkspace({
  root: process.cwd(),
  dryRun: false,
  plugins: [
    '@semantic-release/changelog',
    '@semantic-release/npm',
    '@semantic-release/github',
    ['@semantic-release/git', { assets: ['CHANGELOG.md', 'package.json'], message: 'chore(release): ${nextRelease.gitTag} [skip ci]' }],
  ],
  analyzeCommits: { preset: 'conventionalcommits' },
});

for (const pkg of outcome.packages) {
  console.log(pkg.name, pkg.released ? `released ${pkg.gitTag}` : 'no release', pkg.dependencyBumps);
}
```

Every stage is also exported individually — `discoverWorkspace`, `buildDependencyGraph`, `topologicalOrder`, `updateDependencyRange`, `createScopedPlugins`, `filterCommitsToDirectory` — along with the error hierarchy (`WorkspaceReleaseError` and friends) so embedders can distinguish orchestration failures from unexpected crashes.

### Repository requirements

- A git repository with a pushable `origin` (semantic-release verifies push access even in dry runs, and pushes tags and release commits in real ones).
- A git identity (`user.name`/`user.email`) in CI for the `[skip ci]` bump commits, or the semantic-release-bot fallback identity is used automatically.
- A recognised CI environment for real runs (semantic-release refuses to publish from an unknown environment unless told otherwise); outside CI it falls back to dry-run behaviour.
- Merge commits count for no package: `git log --name-only` lists no files for them, so their changes arrive through their parents, which the same range covers individually. Squash-merge workflows are unaffected, since a squash commit is an ordinary commit with a full file list.

## Status

The full orchestration path — discovery, topological ordering with cycle rejection, path-scoped analysis and notes, cross-package manifest bumping with forced patch releases, and the standard publish pipeline — is implemented and exercised end to end by the test suite against real temporary git workspaces (real commits, tags, bare remotes, and semantic-release runs with the npm registry switched off), not just by unit tests of the pieces in isolation.

Tracked follow-up work lives in [documents.js#664](https://github.com/ExaDev/documents.js/issues/664), which also covers migrating the documents.js ecosystem's repositories onto this tool.

## Development

```sh
pnpm install
pnpm run lint         # eslint, zero warnings
pnpm run typecheck    # tsc --noEmit, strict
pnpm run test         # vitest: unit + real-git integration fixtures
pnpm run build        # tsdown: dist/ library + bin
pnpm run test:smoke   # rebuilds, then spawns the real dist/cli.js as a subprocess
```

Conventional commits, enforced by commitlint; releases of this package itself go through semantic-release on `main`.

## License

MIT
