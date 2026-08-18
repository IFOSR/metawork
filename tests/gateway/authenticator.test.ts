import { describe, expect, it } from 'vitest';
import { LocalAuthenticator } from '../../src/gateway/authenticator.js';
import {
  LOCAL_INSTALLATION_PRINCIPAL_ID,
  localPrincipal,
} from '../../src/gateway/local-principal.js';

describe('LocalAuthenticator', () => {
  it('produces a local installation principal for local transport', async () => {
    const authenticator = new LocalAuthenticator();
    const principal = await authenticator.authenticate({ transport: 'local' });
    expect(principal).toEqual({ kind: 'local', id: LOCAL_INSTALLATION_PRINCIPAL_ID });
  });

  it('refuses non-local transports', async () => {
    const authenticator = new LocalAuthenticator();
    for (const transport of ['web', 'feishu', 'app'] as const) {
      expect(await authenticator.authenticate({ transport })).toBeNull();
    }
  });

  it('exposes a stable local principal identity', () => {
    const principal = localPrincipal();
    expect(principal.kind).toBe('local');
    expect(principal.id).toBe(LOCAL_INSTALLATION_PRINCIPAL_ID);
  });
});
