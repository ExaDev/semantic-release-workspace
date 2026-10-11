import { describe, expect, it } from 'vitest';
import { formatDependencyBumpMessage, parseDependencyBumpTrailer } from './dependency-bump-commit';

describe('formatDependencyBumpMessage / parseDependencyBumpTrailer', () => {
  it('round-trips a bump through the commit message it produces', () => {
    const message = formatDependencyBumpMessage({ dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', releaseType: 'minor', dependent: '@fixture/b' });
    expect(message).toBe(
      [
        'chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]',
        '',
        'Bumped-Workspace-Dependency: @fixture/a',
        'Bumped-Workspace-Dependency-Version: 1.1.0',
        'Bumped-Workspace-Dependency-Range: ^1.1.0',
        'Bumped-Workspace-Dependency-Release-Type: minor',
      ].join('\n'),
    );
    expect(parseDependencyBumpTrailer(message)).toEqual({ dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', releaseType: 'minor' });
  });

  it('recovers a bump commit written before the trailer recorded a release type, with no type', () => {
    const legacy = [
      'chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]',
      '',
      'Bumped-Workspace-Dependency: @fixture/a',
      'Bumped-Workspace-Dependency-Version: 1.1.0',
      'Bumped-Workspace-Dependency-Range: ^1.1.0',
    ].join('\n');
    expect(parseDependencyBumpTrailer(legacy)).toEqual({ dependency: '@fixture/a', version: '1.1.0', range: '^1.1.0', releaseType: undefined });
  });

  it('ignores a release type line that names no semantic-release release type', () => {
    const message = formatDependencyBumpMessage({ dependency: '@fixture/a', version: '2.0.0', range: '^2.0.0', releaseType: 'major', dependent: '@fixture/b' }).replace(
      'Release-Type: major',
      'Release-Type: enormous',
    );
    expect(parseDependencyBumpTrailer(message)).toMatchObject({ dependency: '@fixture/a', releaseType: undefined });
  });

  it('returns undefined for an ordinary commit carrying none of the trailer lines', () => {
    expect(parseDependencyBumpTrailer('feat(a): add a feature\n\nSome unrelated body text.')).toBeUndefined();
  });

  it('returns undefined when only part of the trailer is present', () => {
    const partial = ['chore(deps): bump @fixture/a to ^1.1.0 in @fixture/b [skip ci]', '', 'Bumped-Workspace-Dependency: @fixture/a'].join('\n');
    expect(parseDependencyBumpTrailer(partial)).toBeUndefined();
  });
});
