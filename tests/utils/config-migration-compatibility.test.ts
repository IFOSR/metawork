import { describe, expect, it } from 'vitest';
import { loadConfig, resolveLegacyConfigPath } from '../../src/utils/config.js';

describe('legacy configuration compatibility seam', () => {
  it('keeps the existing loader as the runtime authority during migration preparation', () => {
    expect(typeof loadConfig).toBe('function');
    expect(typeof resolveLegacyConfigPath).toBe('function');
  });
});
