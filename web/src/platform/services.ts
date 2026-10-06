import type { DesktopBridge, DesktopPreferences } from '../../../apps/desktop/shared/bridge';

declare global { interface Window { metaworkDesktop?: DesktopBridge } }

/** The browser uses its existing HTTP controls when native capabilities are absent. */
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' && window.metaworkDesktop?.version === 1
    ? window.metaworkDesktop : undefined;
}

let preferences: DesktopPreferences | null = null;
export function desktopPreferences(): DesktopPreferences | null { return preferences; }
export async function initializePlatform(): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge) return;
  preferences = await bridge.readPreferences();
  if (!window.location.hash && preferences.route) window.history.replaceState(null, '', preferences.route);
  document.documentElement.dataset.platform = 'desktop';
}

export function reportPersistenceError(): void {
  window.dispatchEvent(new CustomEvent('metawork:persistence-error'));
}
