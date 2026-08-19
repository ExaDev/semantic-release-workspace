import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDiscoveryError } from './errors';
import { discoverWorkspace } from './workspace';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-discovery-'));
  temporaryDirectories.push(root);
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  return root;
}

async function writePackage(root: string, directory: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('discoverWorkspace', () => {
  it('discovers every matched package with its dependency fields, workspace-agnostic of any specific ecosystem layout', async () => {
    const root = await temporaryWorkspace();
    await writePackage(root, 'packages/alpha', { name: '@demo/alpha', version: '1.0.0' });
    await writePackage(root, 'packages/beta', {
      name: '@demo/beta',
      version: '2.0.0',
      dependencies: { '@demo/alpha': 'workspace:^' },
      devDependencies: { typescript: '^5.0.0' },
      peerDependencies: { '@demo/alpha': '^1.0.0' },
    });

    const workspace = await discoverWorkspace(root);
    expect(workspace.packages.map((pkg) => pkg.name)).toEqual(['@demo/alpha', '@demo/beta']);
    const beta = workspace.packages[1];
    expect(beta?.relativeDirectory).toBe('packages/beta');
    expect([...(beta?.dependencies.get('dependencies') ?? [])]).toEqual([['@demo/alpha', 'workspace:^']]);
    expect([...(beta?.dependencies.get('peerDependencies') ?? [])]).toEqual([['@demo/alpha', '^1.0.0']]);
  });

  it('never matches a manifest inside node_modules, however permissive the globs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-discovery-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "**"\n');
    await writePackage(root, 'packages/real', { name: 'real', version: '1.0.0' });
    await writePackage(root, 'node_modules/hidden/package', { name: 'hidden', version: '1.0.0' });

    const workspace = await discoverWorkspace(root);
    expect(workspace.packages.map((pkg) => pkg.name)).toEqual(['real']);
  });

  it('rejects a package at the workspace root, which cannot be path-scoped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-discovery-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n  - packages/*\n');
    await writePackage(root, 'packages/real', { name: 'real', version: '1.0.0' });
    await writePackage(root, '.', { name: 'root-package', version: '1.0.0' });

    await expect(discoverWorkspace(root)).rejects.toThrow(WorkspaceDiscoveryError);
    await expect(discoverWorkspace(root)).rejects.toThrow(/root itself/);
  });

  it('rejects two packages claiming the same name', async () => {
    const root = await temporaryWorkspace();
    await writePackage(root, 'packages/one', { name: '@demo/duplicate', version: '1.0.0' });
    await writePackage(root, 'packages/two', { name: '@demo/duplicate', version: '1.0.0' });

    await expect(discoverWorkspace(root)).rejects.toThrow(/both named "@demo\/duplicate"/);
  });

  it('rejects a workspace with no matching packages', async () => {
    const root = await temporaryWorkspace();
    await expect(discoverWorkspace(root)).rejects.toThrow(/No packages matched/);
  });

  it('rejects a manifest without a name or a version', async () => {
    const root = await temporaryWorkspace();
    await writePackage(root, 'packages/anonymous', { version: '1.0.0' });
    await expect(discoverWorkspace(root)).rejects.toThrow(/no "name"/);

    const other = await temporaryWorkspace();
    await writePackage(other, 'packages/unversioned', { name: '@demo/unversioned' });
    await expect(discoverWorkspace(other)).rejects.toThrow(/no "version"/);
  });
});
