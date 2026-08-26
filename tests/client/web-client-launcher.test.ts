import { describe, expect, it, vi } from 'vitest';
import { WebClientLauncher } from '../../src/client/web-client-launcher.js';

describe('WebClientLauncher', () => {
  it('opens only the existing Server origin and never starts Runtime', async () => {
    const open = vi.fn();
    const launcher = new WebClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      open,
    });

    await launcher.start({ conversationId: 'conv_1', noOpen: false });
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:8788/?conversation=conv_1');
  });

  it('supports no-open without changing the Server lifecycle', async () => {
    const open = vi.fn();
    const launcher = new WebClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      open,
    });

    await launcher.start({ conversationId: undefined, noOpen: true });
    expect(open).not.toHaveBeenCalled();
  });
});
