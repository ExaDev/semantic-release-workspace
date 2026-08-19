#!/usr/bin/env node
import { Command } from 'commander';
// resolveJsonModule lets rolldown (via tsdown) inline this package's own declared version straight into the bundle at build time -- no runtime fs read.
import { version } from '../package.json';

/**
 * Builds the commander program but never parses argv or exits the process itself, so it stays testable as pure construction. The orchestration subcommands (discover workspace packages, run semantic-release per package) register here in a follow-up change.
 */
export function createProgram(): Command {
  const program = new Command('semantic-release-workspace');
  program.description('Independent per-package semantic-release orchestration for pnpm workspaces, without lockstep versioning.');
  program.version(version);
  return program;
}

createProgram().parse(process.argv);
