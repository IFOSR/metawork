import { describe, expect, it } from 'vitest';
import { resolveServerWebPort } from '../../src/server/server-web-port.js';

describe('resolveServerWebPort', () => {
  it('uses the product default unless an isolated acceptance port is requested', () => {
    expect(resolveServerWebPort({})).toBe(8788);
    expect(resolveServerWebPort({ METAWORK_WEB_PORT: '0' })).toBe(0);
    expect(resolveServerWebPort({ METAWORK_WEB_PORT: '18888' })).toBe(18888);
  });

  it('rejects invalid port overrides', () => {
    expect(() => resolveServerWebPort({ METAWORK_WEB_PORT: '-1' })).toThrow(
      'METAWORK_WEB_PORT',
    );
    expect(() => resolveServerWebPort({ METAWORK_WEB_PORT: '70000' })).toThrow(
      'METAWORK_WEB_PORT',
    );
  });
});
