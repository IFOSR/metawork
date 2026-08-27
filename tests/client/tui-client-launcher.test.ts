import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TuiClientLauncher } from '../../src/client/tui-client-launcher.js';

describe('TuiClientLauncher', () => {
  it('connects only after endpoint resolution and passes Conversation attach', async () => {
    const runUi = vi.fn(async () => undefined);
    const launcher = new TuiClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      conversationId: 'conv_1',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      runUi,
    });

    await launcher.start();
    expect(runUi).toHaveBeenCalledWith('/tmp/gateway.sock', 'conv_1', '/repo-a');
  });

  it('does not spawn the Client when Server is offline', async () => {
    const runUi = vi.fn(async () => undefined);
    const launcher = new TuiClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint: async () => ({
        ok: false,
        code: 'server_unavailable',
        message: 'MetaWork Server is unavailable; run `metawork server start`.',
      }),
      runUi,
    });

    await expect(launcher.start()).rejects.toThrow('metawork server start');
    expect(runUi).not.toHaveBeenCalled();
  });

  it('starts a new Conversation when no attach ID is provided', async () => {
    const runUi = vi.fn(async () => undefined);
    const launcher = new TuiClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      runUi,
    });

    await launcher.start();

    expect(runUi).toHaveBeenCalledWith('/tmp/gateway.sock', undefined, '/repo-a');
  });

  it('does not require a client-generated Conversation ID for the vendored client', async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    const launcher = new TuiClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      command: '/tmp/pi-client',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint: async () => ({
        ok: true,
        manifestVersion: 1,
        socketPath: '/tmp/gateway.sock',
        webOrigin: 'http://127.0.0.1:8788',
      }),
      spawn: spawnProcess as never,
    });

    await launcher.start();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/tmp/pi-client',
      ['--gateway-socket', '/tmp/gateway.sock', '--workspace-hint', '/repo-a'],
      expect.objectContaining({
        cwd: '/repo-a',
        stdio: 'inherit',
        env: expect.not.objectContaining({
          ANYFUSION_PLANNER_WORKSPACE: expect.anything(),
        }),
      }),
    );
  });
});
