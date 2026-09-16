import { describe, expect, it } from 'vitest';
import {
  formatWebAccessTokenLine,
  generateToken,
} from '../../src/management/token.js';

describe('management Web token', () => {
  it('labels the token as local Web access rather than a Provider credential', () => {
    expect(formatWebAccessTokenLine('test-token')).toBe(
      'MetaWork Web 本机访问 token（仅用于 --no-open/SSH，非 Provider API Key）: test-token',
    );
  });

  it('generates a non-empty process token', () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  });

});
