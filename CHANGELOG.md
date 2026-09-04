## [1.2.2](https://github.com/ExaDev/semantic-release-workspace/compare/v1.2.1...v1.2.2) (2026-09-04)

## [1.2.1](https://github.com/ExaDev/semantic-release-workspace/compare/v1.2.0...v1.2.1) (2026-09-03)

# [1.2.0](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.7...v1.2.0) (2026-09-02)


### Bug Fixes

* **git:** strip repository-discovery env vars before spawning git subprocesses ([64c8c96](https://github.com/ExaDev/semantic-release-workspace/commit/64c8c964c42ecf45f573b5ac676484c0cf576e69))
* sanitize GIT_DIR-style env vars passed to semantic-release, and unset them in pre-push ([bfe78a2](https://github.com/ExaDev/semantic-release-workspace/commit/bfe78a2db99f94289afe5ea7fa38ba3c6085dce3))


### Features

* add commitStrategy option with a single-combined-commit release mode ([17b386e](https://github.com/ExaDev/semantic-release-workspace/commit/17b386e4f5ba4c5176b00f5f79be407fe39ef912))
* **cli:** add --commit-strategy flag and config field ([e449e06](https://github.com/ExaDev/semantic-release-workspace/commit/e449e0699372b8ebac881ce13bfa44be0ec9b967))
* **git:** add tag/push/working-tree helpers for combined release commits ([d213cf8](https://github.com/ExaDev/semantic-release-workspace/commit/d213cf8f23d9880cae13bc91f3c77809b5662ece))
* **plugins:** add single-commit default plugins, git-plugin rejection, and a commit-capture hook ([c276a73](https://github.com/ExaDev/semantic-release-workspace/commit/c276a73044c6443dd2ef01ce2465154b89365aab))

## [1.1.7](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.6...v1.1.7) (2026-09-02)

## [1.1.6](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.5...v1.1.6) (2026-09-01)

## [1.1.5](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.4...v1.1.5) (2026-09-01)

## [1.1.4](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.3...v1.1.4) (2026-09-01)

## [1.1.3](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.2...v1.1.3) (2026-09-01)

## [1.1.2](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.1...v1.1.2) (2026-08-31)

## [1.1.1](https://github.com/ExaDev/semantic-release-workspace/compare/v1.1.0...v1.1.1) (2026-08-27)

# [1.1.0](https://github.com/ExaDev/semantic-release-workspace/compare/v1.0.3...v1.1.0) (2026-08-24)


### Features

* load --config through cosmiconfig for multi-format support ([9f8d719](https://github.com/ExaDev/semantic-release-workspace/commit/9f8d719d656c485051f15c880f64e8377620fcc1))

## [1.0.3](https://github.com/ExaDev/semantic-release-workspace/compare/v1.0.2...v1.0.3) (2026-08-20)


### Bug Fixes

* regenerate and commit the lockfile alongside every dependency bump ([40e37a3](https://github.com/ExaDev/semantic-release-workspace/commit/40e37a35a60b052ec79a150199c768f8a3ab1460))

## [1.0.2](https://github.com/ExaDev/semantic-release-workspace/compare/v1.0.1...v1.0.2) (2026-08-20)


### Bug Fixes

* retry temp workspace cleanup past a lingering git gc race ([fede08c](https://github.com/ExaDev/semantic-release-workspace/commit/fede08c5cd20b2ef14aa4fc4e1bdfd05a2fcc4d3))
* stop createScopedPlugins crashing on a package's genuine first release ([c15e40e](https://github.com/ExaDev/semantic-release-workspace/commit/c15e40e9c4e0d8a19755bd3c06327dc1ed547a20))

## [1.0.1](https://github.com/ExaDev/semantic-release-workspace/compare/v1.0.0...v1.0.1) (2026-08-20)


### Bug Fixes

* default env to process.env, since spreading undefined silently drops it ([13f6992](https://github.com/ExaDev/semantic-release-workspace/commit/13f69922b49a4896d712816476b08698a309407b))

# 1.0.0 (2026-08-19)


### Bug Fixes

* raise a workspace-state error for a detached HEAD, not a git command error ([12c7e89](https://github.com/ExaDev/semantic-release-workspace/commit/12c7e898a7aa401438ed17d6c2940aba048c7db0))
* recover the forced-patch decision from history, not only in-memory state ([29a22c5](https://github.com/ExaDev/semantic-release-workspace/commit/29a22c542a5bf48c43667563da0d4507d39317b7))
* reject package names that would inject a template into semantic-release's tagFormat ([5b0ed80](https://github.com/ExaDev/semantic-release-workspace/commit/5b0ed80f68445609c15c2ac41a81c7571a470ba0))
* scope path-filtered commit analysis to the git repository toplevel ([9d76cec](https://github.com/ExaDev/semantic-release-workspace/commit/9d76cecc437f6892cfbdca0b1c3574e260d044dd))
* stop git C-quoting non-ASCII commit paths from breaking path scoping ([ed2348a](https://github.com/ExaDev/semantic-release-workspace/commit/ed2348a2582504227d593778f665cdd1d1d3ec83))
* validate every dependency range shape before any package releases ([6548dcf](https://github.com/ExaDev/semantic-release-workspace/commit/6548dcf34a421ff6a6bbe27e669336ee52d8a414))


### Features

* discover pnpm workspace packages and build their dependency graph ([e4727aa](https://github.com/ExaDev/semantic-release-workspace/commit/e4727aab432cec9bacaf3514bfd3eb11fd82b1d6))
* expose the orchestrator through the CLI and public API ([66faf08](https://github.com/ExaDev/semantic-release-workspace/commit/66faf08d4cea83ffcfcfca9831b4367fd86f03c1))
* orchestrate per-package releases with cross-package manifest bumping ([ce80c09](https://github.com/ExaDev/semantic-release-workspace/commit/ce80c0909d3b059aff579981590dbb26e61202cc))
* scope semantic-release analysis to a package's own commits ([12db69d](https://github.com/ExaDev/semantic-release-workspace/commit/12db69d89c725364542343fe6fd386b4f192bf39))
