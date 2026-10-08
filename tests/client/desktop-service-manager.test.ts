import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopServiceManager } from '../../src/client/desktop-service-manager.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), discover: vi.fn(), endpoint: vi.fn() }));
vi.mock('../../src/installation/macos-background-process.js', () => ({ startMacOSBackgroundProcess: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../src/management/lock.js', () => ({ isInstanceRunning: async () => true }));
vi.mock('../../src/client/desktop-session-client.js', () => ({ discoverDesktopSession: mocks.discover }));
vi.mock('../../src/client/client-endpoint-resolver.js', () => ({ resolveClientEndpoint: mocks.endpoint }));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('uses the formal lifecycle for legacy Web Servers without requiring Desktop sessions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-native-lifecycle-'))); roots.push(root);
  const release = join(root, 'app/releases/native');
  const tools = join(root, 'desktop-support/current/desktop-tools');
  const node = join(tools, 'node/bin/node');
  await mkdir(join(release, 'dist'), { recursive: true });
  await mkdir(join(tools, 'node/bin'), { recursive: true });
  await writeFile(node, 'fixture', { mode: 0o755 });
  await writeFile(join(release, 'dist/index.js'), 'fixture');
  await writeFile(join(release, 'release-identity.json'), JSON.stringify({ version: 1, releaseId: 'native', gatewayProtocolVersion: 2 }));
  await symlink('releases/native', join(root, 'app/current'));
  mocks.discover.mockRejectedValue(new Error('Legacy Server has no Desktop sessions'));
  mocks.endpoint.mockResolvedValue({ ok: true });
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  const manager = new DesktopServiceManager({ installRoot: root, releaseId: 'native', nodePath: node });
  await manager.stopForUpdate();
  await manager.startForUpdate();
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledWith(node, [join(release, 'dist/index.js'), 'server', 'stop'],
    expect.objectContaining({ env: expect.objectContaining({ METAWORK_INSTALL_ROOT: root,
      PATH: expect.stringContaining(join(tools, 'executor/bin')) }) }));
  expect(mocks.endpoint).toHaveBeenCalledWith(join(root, 'server-endpoint.json'), 2, { releaseId: 'native' });
  // Ordinary user-facing stop keeps its authenticated Desktop guard.
  await expect(manager.stop()).rejects.toThrow('no Desktop sessions');
});
