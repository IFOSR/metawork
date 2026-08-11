import { describe, expect, it } from 'vitest';
import { resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses ANYFUSION_INSTALL_ROOT as the only state root override', () => {
    expect(resolveMetaclawDir('./tmp/anyfusion-root', '/Users/demo')).toMatch(/tmp\/anyfusion-root\/data$/);
  });

  it('falls back to ~/.anyfusion/data when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo')).toBe('/Users/demo/.anyfusion/data');
  });
});
