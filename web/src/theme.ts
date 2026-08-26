import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'metawork.theme';
export const LEGACY_THEME_STORAGE_KEY = 'anyfusion.theme';

export function readThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  return preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  storage.setItem(THEME_STORAGE_KEY, preference);
}

export function readStoredThemePreference(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.localStorage,
): ThemePreference {
  const canonicalValue = storage.getItem(THEME_STORAGE_KEY);
  const legacyValue = storage.getItem(LEGACY_THEME_STORAGE_KEY);
  const preference = canonicalValue === null
    ? readThemePreference(legacyValue)
    : readThemePreference(canonicalValue);

  if (canonicalValue === null && legacyValue !== null) {
    storage.setItem(THEME_STORAGE_KEY, preference);
  }
  if (legacyValue !== null) {
    storage.removeItem(LEGACY_THEME_STORAGE_KEY);
  }
  return preference;
}

export function useThemePreference(): [
  ThemePreference,
  (preference: ThemePreference) => void,
] {
  const [preference, setPreference] = useState<ThemePreference>(() => (
    readStoredThemePreference()
  ));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = resolveTheme(preference, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    writeThemePreference(preference);
    if (preference !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  return [preference, setPreference];
}
