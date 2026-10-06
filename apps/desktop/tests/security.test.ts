import { describe, expect, it } from 'vitest';
import { assertMainFrame, externalUrl, identifier } from '../main/security.js';

describe('Native capability document scope', () => {
  const frame = { senderId: 1, ownerId: 1, mainFrame: true, url: 'http://127.0.0.1:8788/#workspace=a', origin: 'http://127.0.0.1:8788' };
  it('allows only the owned workspace document', () => {
    expect(() => assertMainFrame(frame)).not.toThrow();
    for (const changed of [{ senderId: 2 }, { mainFrame: false }, { origin: null },
      { url: 'http://127.0.0.1:8788/api/artifacts/document/preview' }, { url: 'https://example.com/' }]) {
      expect(() => assertMainFrame({ ...frame, ...changed })).toThrow();
    }
  });
  it('limits external navigation and rejects unsafe identifiers', () => {
    expect(externalUrl('https://example.com/docs')).toBe('https://example.com/docs');
    for (const url of ['file:///tmp/test', 'javascript:void(0)', 'https://user:pass@example.com']) expect(externalUrl(url)).toBeNull();
    expect(identifier('../path')).toBe(false); expect(identifier('__proto__')).toBe(false);
  });
});
