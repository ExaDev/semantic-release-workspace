import { describe, expect, it } from 'vitest';
import { packageName } from './index';

describe('packageName', () => {
  it('matches the published package name', () => {
    expect(packageName).toBe('@exadev/semantic-release-workspace');
  });
});
