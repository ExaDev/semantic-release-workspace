import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './git';

/**
 * Builds a throwaway pnpm workspace with a real git repository, a real bare remote, real commits, and real `name@version` tags -- the substrate the orchestrator's tests drive end to end. Nothing here is installed with pnpm: the orchestrator's discovery reads `pnpm-workspace.yaml` and manifests, and semantic-release only needs git.
 */

export interface FixturePackage {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
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

export async function createWorkspaceFixture(packages: readonly FixturePackage[], commits: readonly FixtureCommit[]): Promise<WorkspaceFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-'));
  const root = join(directory, 'workspace');
  const remote = join(directory, 'remote.git');

  await mkdir(root);
  await git(['init', '--initial-branch=main', root], { cwd: directory });
  await git(['init', '--bare', '--initial-branch=main', remote], { cwd: directory });
  await git(['config', 'user.name', 'Fixture Release Bot'], { cwd: root });
  await git(['config', 'user.email', 'fixture@example.com'], { cwd: root });
  // semantic-release creates lightweight tags (`git tag <name> <sha>`). A developer machine with a global `tag.gpgsign true` would turn that into an annotated signing request with no message and no key, so the fixture repository pins the default off for everything that tags inside it -- the fixture builder and semantic-release's own runs alike.
  await git(['config', 'tag.gpgsign', 'false'], { cwd: root });

  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await commit(root, 'chore: scaffold workspace', ['pnpm-workspace.yaml']);

  for (const pkg of packages) {
    const directoryName = unscopedName(pkg.name);
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

  return { root, remote, remove: () => rm(directory, { recursive: true, force: true }) };
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
