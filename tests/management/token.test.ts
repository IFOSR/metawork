import { describe, expect, it } from 'vitest';
import {
  buildWebStartupPresentation,
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

  it('hides credentials during normal automatic browser startup', () => {
    expect(buildWebStartupPresentation(
      'http://127.0.0.1:8788',
      'bootstrap token',
      'manual-token',
      false,
    )).toEqual({
      browserUrl: 'http://127.0.0.1:8788/#bootstrap=bootstrap+token',
      terminalLines: [
        'MetaWork Web: http://127.0.0.1:8788',
        '浏览器将自动完成本机登录；若未打开，请使用 `metawork web --no-open`。',
      ],
    });
  });

  it('prints only the manual fallback token for no-open mode', () => {
    expect(buildWebStartupPresentation(
      'http://127.0.0.1:8788',
      'bootstrap-token',
      'manual-token',
      true,
    )).toEqual({
      browserUrl: 'http://127.0.0.1:8788',
      terminalLines: [
        'MetaWork Web: http://127.0.0.1:8788',
        'MetaWork Web 本机访问 token（仅用于 --no-open/SSH，非 Provider API Key）: manual-token',
      ],
    });
  });
});
