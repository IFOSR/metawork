import { describe, expect, it } from 'vitest';
import { resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses a resolved product installation root override', () => {
    expect(resolveMetaclawDir('./tmp/metawork-root', '/Users/demo')).toMatch(/tmp\/metawork-root\/data$/);
  });

  it('falls back to ~/.metawork/data when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo')).toBe('/Users/demo/.metawork/data');
  });
});
