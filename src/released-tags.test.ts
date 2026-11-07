import { describe, expect, it } from 'vitest';
import { git } from './git';
import { createWorkspaceFixture } from './git-workspace-fixture';
import { releasedTags } from './released-tags';
import { TestTimeoutMs } from './test-timeouts';

describe('releasedTags', () => {
  it('lists the release versions tagged on this branch, highest first, ignoring prereleases and other packages', async () => {
    const fixture = await createWorkspaceFixture(
      [
        { name: '@fixture/a', version: '1.0.0' },
        { name: '@fixture/ab', version: '3.0.0' },
      ],
      [
        { message: 'fix(a): one', files: { 'packages/a/src/index.js': 'export const a = 1;\n' }, tag: '@fixture/a@1.10.0' },
        { message: 'fix(a): two', files: { 'packages/a/src/index.js': 'export const a = 2;\n' }, tag: '@fixture/a@1.9.0' },
        { message: 'feat(a): three', files: { 'packages/a/src/index.js': 'export const a = 3;\n' }, tag: '@fixture/a@2.0.0-beta.1' },
      ],
    );
    try {
      await expect(releasedTags('@fixture/a', '${name}@${version}', { cwd: fixture.root })).resolves.toEqual([
        { version: '1.10.0', gitTag: '@fixture/a@1.10.0' },
        { version: '1.9.0', gitTag: '@fixture/a@1.9.0' },
        { version: '1.0.0', gitTag: '@fixture/a@1.0.0' },
      ]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Short);

  it('ignores a tag on a commit this branch does not contain', async () => {
    const fixture = await createWorkspaceFixture([{ name: '@fixture/a', version: '1.0.0' }], []);
    try {
      await git(['checkout', '-q', '-b', 'side'], { cwd: fixture.root });
      await git(['commit', '-q', '--allow-empty', '-m', 'fix(a): side'], { cwd: fixture.root });
      await git(['tag', '@fixture/a@1.0.1'], { cwd: fixture.root });
      await git(['checkout', '-q', 'main'], { cwd: fixture.root });

      await expect(releasedTags('@fixture/a', '${name}@${version}', { cwd: fixture.root })).resolves.toEqual([{ version: '1.0.0', gitTag: '@fixture/a@1.0.0' }]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Short);

  it('reads tags in a custom tag format', async () => {
    const fixture = await createWorkspaceFixture([{ name: 'setup', version: '2.1.0' }], [], { tagFormat: '${name}-v${version}' });
    try {
      await expect(releasedTags('setup', '${name}-v${version}', { cwd: fixture.root })).resolves.toEqual([{ version: '2.1.0', gitTag: 'setup-v2.1.0' }]);
    } finally {
      await fixture.remove();
    }
  }, TestTimeoutMs.Short);
});
