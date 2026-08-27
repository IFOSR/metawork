import { describe, expect, it, vi } from 'vitest';
import { WebClientLauncher } from '../../src/client/web-client-launcher.js';

describe('WebClientLauncher', () => {
  it('registers the startup Workspace through the local Gateway and opens only an opaque token', async () => {
    const open = vi.fn();
    const registerLaunch = vi.fn(async () => ({
      token: 'opaque-bootstrap-token',
      expiresAt: '2026-08-27T08:01:00.000Z',
    }));
    const launcher = new WebClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      registerLaunch,
      open,
    });

    const url = await launcher.start({ conversationId: 'conv_1', noOpen: false });

    expect(registerLaunch).toHaveBeenCalledWith('/tmp/gateway.sock', {
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    expect(open).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/#bootstrap=opaque-bootstrap-token',
    );
    expect(url).not.toContain('/repo-a');
    expect(url).not.toContain('workspace=');
    expect(url).not.toContain('conversation=');
  });

  it('supports no-open without changing the Server lifecycle', async () => {
    const open = vi.fn();
    const launcher = new WebClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      startupWorkspacePath: '/repo-b',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      registerLaunch: async () => ({
        token: 'opaque-bootstrap-token',
        expiresAt: '2026-08-27T08:01:00.000Z',
      }),
      open,
    });

    await expect(launcher.start({ conversationId: undefined, noOpen: true })).resolves.toBe(
      'http://127.0.0.1:8788/#bootstrap=opaque-bootstrap-token',
    );
    expect(open).not.toHaveBeenCalled();
  });
});
