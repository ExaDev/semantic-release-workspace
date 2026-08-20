import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { git } from './git';

const execFileAsync = promisify(execFile);

/**
 * Builds a throwaway pnpm workspace with a real git repository, a real bare remote, real commits, and real `name@version` tags -- the substrate the orchestrator's tests drive end to end. The orchestrator's own discovery reads only `pnpm-workspace.yaml` and manifests and never invokes pnpm itself, but `bumpDependents`'s lockfile regeneration does, so a dependency-range bump against this fixture runs a real `pnpm install --lockfile-only`.
 */

export interface FixturePackage {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  /** Directory name under `packages/`, when it needs to differ from the package name's own unscoped form -- for example a real npm name paired with a directory that has a space or a non-ASCII character in it, which a valid npm name can never contain itself. Defaults to the unscoped package name. */
  readonly directory?: string;
}

export interface FixtureCommit {
  readonly message: string;
  /** Files to write before committing, keyed by POSIX path relative to the workspace root. */
  readonly files?: Readonly<Record<string, string>>;
  /** A `name@version` tag to place on the resulting commit, as a previous release of that package. */
  readonly tag?: string;
}

export interface WorkspaceFixture {
  readonly root: string;
  readonly remote: string;
  readonly remove: () => Promise<void>;
}

export interface WorkspaceFixtureOptions {
  /** Path, relative to the git repository's toplevel, where `pnpm-workspace.yaml` and the packages live. Defaults to the repository toplevel itself. Set this to reproduce a workspace that is not itself the git toplevel -- e.g. a monorepo checked out with the pnpm workspace one level below the repository root. */
  readonly workspaceSubdirectory?: string;
  /**
   * Generates a real `pnpm-lock.yaml` from the fixture's own packages (via `pnpm install --lockfile-only`) and commits it as its own history entry before the fixture's own commits run, for tests that need a lockfile already present in history to observe it being kept in sync across a bump. Defaults to `false`: most tests don't assert anything about the lockfile, so they don't need one to already exist -- `regenerateLockfile` (see `pnpm.ts`) creates it from nothing the first time a dependency-range bump runs, same as it would in a repository adopting this tool for the first time.
   */
  readonly pnpmLockfile?: boolean;
}

export async function createWorkspaceFixture(
  packages: readonly FixturePackage[],
  commits: readonly FixtureCommit[],
  options: WorkspaceFixtureOptions = {},
): Promise<WorkspaceFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-'));
  const gitRoot = join(directory, 'workspace');
  const root = options.workspaceSubdirectory === undefined ? gitRoot : join(gitRoot, options.workspaceSubdirectory);
  const remote = join(directory, 'remote.git');

  await mkdir(root, { recursive: true });
  await git(['init', '--initial-branch=main', gitRoot], { cwd: directory });
  await git(['init', '--bare', '--initial-branch=main', remote], { cwd: directory });
  await git(['config', 'user.name', 'Fixture Release Bot'], { cwd: root });
  await git(['config', 'user.email', 'fixture@example.com'], { cwd: root });
  // semantic-release creates lightweight tags (`git tag <name> <sha>`). A developer machine with a global `tag.gpgsign true` would turn that into an annotated signing request with no message and no key, so the fixture repository pins the default off for everything that tags inside it -- the fixture builder and semantic-release's own runs alike.
  await git(['config', 'tag.gpgsign', 'false'], { cwd: root });

  // linkWorkspacePackages is always on: any fixture with a dependent whose range gets rewritten now exercises a real `pnpm install --lockfile-only` (see `regenerateLockfile` in `release.ts`'s bumpDependents), and without it pnpm would try to resolve a plain semver range like `^1.0.0` against the real npm registry -- where none of these `@fixture/*` names exist -- rather than linking the workspace sibling.
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\nlinkWorkspacePackages: true\n');
  await commit(root, 'chore: scaffold workspace', ['pnpm-workspace.yaml']);

  for (const pkg of packages) {
    const directoryName = pkg.directory ?? unscopedName(pkg.name);
    await mkdir(join(root, 'packages', directoryName, 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', directoryName, 'package.json'),
      `${JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          private: true,
          type: 'module',
          ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies }),
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(root, 'packages', directoryName, 'src', 'index.js'), 'export {};\n');
    await commit(root, `feat(${directoryName}): scaffold ${pkg.name}`, [
      `packages/${directoryName}/package.json`,
      `packages/${directoryName}/src/index.js`,
    ]);
    await git(['tag', tagFor(pkg.name, pkg.version)], { cwd: root });
  }

  if (options.pnpmLockfile === true) {
    await execFileAsync('pnpm', ['install', '--lockfile-only'], { cwd: root });
    await commit(root, 'chore: lockfile', ['pnpm-lock.yaml']);
  }

  for (const fixtureCommit of commits) {
    for (const [path, content] of Object.entries(fixtureCommit.files ?? {})) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    await commit(root, fixtureCommit.message, Object.keys(fixtureCommit.files ?? {}));
    if (fixtureCommit.tag !== undefined) {
      await git(['tag', fixtureCommit.tag], { cwd: root });
    }
  }

  // The remote is registered as a file:// URL rather than a bare path: semantic-release parses repositoryUrl with git-url-parse, which rejects plain filesystem paths, and every git operation (ls-remote, fetch, push) treats the two identically.
  await git(['remote', 'add', 'origin', pathToFileURL(remote).href], { cwd: root });
  await git(['push', '-u', 'origin', 'main', '--tags'], { cwd: root });

  // maxRetries/retryDelay: `git push`/`git commit` can leave a background `git gc --auto` still writing into `remote.git/objects` or `.git/objects` for a moment after the command that triggered it returns, which occasionally loses the race against this recursive delete with ENOTEMPTY -- exactly the error class Node's own retry option exists for.
  return { root, remote, remove: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

async function commit(root: string, message: string, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) {
    await git(['add', '--', ...paths], { cwd: root });
  }
  await git(['commit', '--allow-empty', '-m', message], { cwd: root });
}

function unscopedName(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

function tagFor(name: string, version: string): string {
  return `${name}@${version}`;
}
