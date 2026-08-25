import { describe, expect, it } from 'vitest';
import {
  readThemePreference,
  resolveTheme,
  writeThemePreference,
} from '../../web/src/theme.js';

describe('web theme preference', () => {
  it('defaults invalid or missing storage values to system', () => {
    expect(readThemePreference(null)).toBe('system');
    expect(readThemePreference('sepia')).toBe('system');
    expect(readThemePreference('light')).toBe('light');
  });

  it('resolves system preference while fixed preferences ignore the media value', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('writes the stable storage key', () => {
    const writes: Array<[string, string]> = [];
    writeThemePreference('dark', {
      setItem: (key, value) => writes.push([key, value]),
    });
    expect(writes).toEqual([['anyfusion.theme', 'dark']]);
  });
});
