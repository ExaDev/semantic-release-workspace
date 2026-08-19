# semantic-release-workspace

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/semantic-release-workspace) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@exadev/semantic-release-workspace) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/semantic-release-workspace/ci.yml?branch=main)](https://github.com/ExaDev/semantic-release-workspace/actions)

> Independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.

A pnpm workspace publishing every package under one shared version number (lockstep) forces an unrelated package to release whenever any sibling changes. This tool runs semantic-release independently per package, driven by each package's own commit history and its own dependency graph within the workspace, so a change to one package never forces a version bump in another.

## Status

Scaffolded; the orchestration logic lands in a follow-up change.

## License

MIT
