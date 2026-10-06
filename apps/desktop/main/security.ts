export function sameOrigin(url: string, expected: string | null): boolean {
  if (!expected) return false;
  try { return new URL(url).origin === expected; } catch { return false; }
}
export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.:-]{1,256}$/u.test(value)
    && !['__proto__', 'prototype', 'constructor', '.', '..'].includes(value);
}
export function businessDocument(url: string, origin: string | null): boolean {
  return sameOrigin(url, origin) && new URL(url).pathname === '/' && !new URL(url).search;
}
export function assertMainFrame(input: {
  senderId: number;
  ownerId: number;
  mainFrame: boolean;
  url: string;
  origin: string | null;
}): void {
  if (input.senderId !== input.ownerId || !input.mainFrame || !businessDocument(input.url, input.origin)) {
    throw new Error('Desktop capability is unavailable to this frame');
  }
}
