import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TuiClientLauncher,
  resolveVendoredPlannerCommand,
} from '../../src/client/tui-client-launcher.js';

describe('TuiClientLauncher', () => {
  it('connects only after endpoint resolution and passes Conversation attach', async () => {
    const runUi = vi.fn(async () => undefined);
    const resolveEndpoint = vi.fn(async () => ({
      ok: true as const,
      manifestVersion: 1,
      socketPath: '/tmp/gateway.sock',
      webOrigin: 'http://127.0.0.1:8788',
    }));
    const launcher = new TuiClientLauncher({
      manifestPath: '/tmp/endpoint.json',
      conversationId: 'conv_1',
      startupWorkspacePath: '/repo-a',
      resolveEndpoint,
      runUi,
    });

    await launcher.start();
    expect(resolveEndpoint).toHaveBeenCalledWith('/tmp/endpoint.json', 2);
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
      process.execPath,
      ['/tmp/pi-client', '--gateway-socket', '/tmp/gateway.sock', '--workspace-hint', '/repo-a'],
      expect.objectContaining({
        cwd: '/repo-a',
        stdio: 'inherit',
        env: expect.not.objectContaining({
          ANYFUSION_PLANNER_WORKSPACE: expect.anything(),
        }),
      }),
    );
  });

  it('runs a non-executable JavaScript client through the current Node runtime', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'metawork-tui-launch-'));
    try {
      const command = join(workspace, 'client.mjs');
      await writeFile(command, `import { writeFileSync } from 'node:fs';
writeFileSync('client-result.json', JSON.stringify({ node: process.execPath, args: process.argv.slice(2) }));`, { mode: 0o600 });
      await new TuiClientLauncher({
        manifestPath: join(workspace, 'endpoint.json'), command, startupWorkspacePath: workspace,
        conversationId: 'conv_attached',
        resolveEndpoint: async () => ({ ok: true, manifestVersion: 1,
          socketPath: 'test-gateway', webOrigin: 'http://127.0.0.1:8788' }),
      }).start();
      expect(JSON.parse(await readFile(join(workspace, 'client-result.json'), 'utf8'))).toEqual({
        node: process.execPath,
        args: ['--gateway-socket', 'test-gateway', '--conversation-id', 'conv_attached', '--workspace-hint', workspace],
      });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('resolves the staged Planner layout from an installed release', () => {
    const installedPlannerCommand = resolve('/install/app/releases/1.2.0-preview.0/planner/packages/coding-agent/dist/cli.js');

    expect(resolveVendoredPlannerCommand(
      '/install/app/releases/1.2.0-preview.0/dist',
      '/workspace-a',
      path => path === installedPlannerCommand,
    )).toBe(installedPlannerCommand);
  });

  it('does not select a Planner binary from the Client startup directory', () => {
    const installedPlannerCommand = resolve('/install/app/current/planner/packages/coding-agent/dist/cli.js');
    const workspacePlannerCommand = resolve('/workspace-a/planner/AnyFusion-Pi/packages/coding-agent/dist/cli.js');

    expect(resolveVendoredPlannerCommand(
      '/install/app/current/dist',
      '/workspace-a',
      path => path === installedPlannerCommand || path === workspacePlannerCommand,
    )).toBe(installedPlannerCommand);
  });
});
