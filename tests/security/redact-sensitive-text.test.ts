import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../../src/utils/redact-sensitive-text.js';

describe('redactSensitiveText', () => {
  it('redacts URL userinfo with the same scheme semantics without quadratic scanning', () => {
    const body = 'x'.repeat(80_000);
    const start = performance.now();
    expect(redactSensitiveText(`${body}\nhttps://alice:password@example.com/report`))
      .toBe(`${body}\nhttps://[REDACTED]@example.com/report`);
    expect(performance.now() - start).toBeLessThan(500);
  }, 20_000);

  it.each([
    ['HTTPS://name:pass@host', 'HTTPS://[REDACTED]@host'],
    ['custom+v1.2://user@host', 'custom+v1.2://[REDACTED]@host'],
    ['123custom://user@host', '123custom://[REDACTED]@host'],
    ['123://user@host', '123://user@host'],
    ['://user@host', '://user@host'],
    ['https://host/path/user@other', 'https://host/path/user@other'],
    ['http://user@one ftp://pass@two', 'http://[REDACTED]@one ftp://[REDACTED]@two'],
    ['token=secret password="with spaces" Bearer credential', 'token=[REDACTED] password=[REDACTED] Bearer [REDACTED]'],
  ])('preserves redaction semantics for %s', (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });
});
