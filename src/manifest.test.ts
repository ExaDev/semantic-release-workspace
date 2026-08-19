import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDiscoveryError } from './errors';
import { readManifest } from './manifest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryManifest(manifest: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-release-workspace-manifest-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'package.json');
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return path;
}

describe('readManifest', () => {
  it('accepts an ordinary scoped package name', async () => {
    const path = await temporaryManifest({ name: '@demo/alpha', version: '1.0.0' });
    const manifest = await readManifest(path);
    expect(manifest.name).toBe('@demo/alpha');
  });

  /**
   * `release.ts` splices `pkg.name` verbatim into semantic-release's `tagFormat`, which semantic-release renders as a lodash template. A name containing a template delimiter such as `<% %>` would execute arbitrary JavaScript at tag-render time -- before npm's own registry ever gets a chance to reject the name -- so discovery has to reject it up front using npm's own package-name rules, not merely check for a non-empty string.
   */
  it('rejects a package name containing a lodash template delimiter', async () => {
    const path = await temporaryManifest({ name: "<%= require('child_process').execSync('id') %>", version: '1.0.0' });
    await expect(readManifest(path)).rejects.toThrow(WorkspaceDiscoveryError);
  });

  it('rejects a package name with other URL-unsafe characters', async () => {
    const path = await temporaryManifest({ name: 'has a space', version: '1.0.0' });
    await expect(readManifest(path)).rejects.toThrow(WorkspaceDiscoveryError);
  });
});
