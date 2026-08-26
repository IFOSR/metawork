import { describe, expect, it } from 'vitest';
import {
  LEGACY_THEME_STORAGE_KEY,
  readStoredThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
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
    expect(writes).toEqual([['metawork.theme', 'dark']]);
    expect(THEME_STORAGE_KEY).toBe('metawork.theme');
  });

  it('migrates the legacy AnyFusion preference once', () => {
    const values = new Map<string, string>([[LEGACY_THEME_STORAGE_KEY, 'dark']]);
    const removals: string[] = [];
    const preference = readStoredThemePreference({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => {
        removals.push(key);
        values.delete(key);
      },
    });

    expect(preference).toBe('dark');
    expect(values.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(removals).toEqual([LEGACY_THEME_STORAGE_KEY]);
  });

  it('prefers the canonical value and removes a stale legacy value', () => {
    const values = new Map<string, string>([
      [THEME_STORAGE_KEY, 'light'],
      [LEGACY_THEME_STORAGE_KEY, 'dark'],
    ]);
    const preference = readStoredThemePreference({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    });

    expect(preference).toBe('light');
    expect(values.has(LEGACY_THEME_STORAGE_KEY)).toBe(false);
  });
});
