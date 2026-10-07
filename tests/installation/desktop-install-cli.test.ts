import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDesktopInstall } from '../../src/desktop-install-cli.js';

const mocks = vi.hoisted(() => ({ install: vi.fn(), update: vi.fn(), rollback: vi.fn(), release: vi.fn() }));
vi.mock('../../src/installation/desktop-release.js', () => ({ verifyDesktopRelease: vi.fn(async () => ({ releaseId: '0.1.5-build-aaaaaaa' })) }));
vi.mock('../../src/installation/source-native-installer.js', () => ({ SourceNativeInstaller: class { install = mocks.install; } }));
vi.mock('../../src/installation/source-native-updater.js', () => ({ SourceNativeUpdater: class { update = mocks.update; rollback = mocks.rollback; } }));
vi.mock('../../src/configuration/production-secret-store.js', () => ({ createProductionSecretStore: vi.fn(() => ({})) }));
vi.mock('../../src/management/lock.js', () => ({ isInstanceRunning: vi.fn(async () => false) }));
vi.mock('../../src/installation/runtime-update-lock.js', () => ({ acquireRuntimeUpdateLock: vi.fn(async () => ({ release: mocks.release })) }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
describe('Desktop installation without developer configuration', () => {
  it.each(['install', 'update'])('finishes %s without reading or creating internal LLM credentials', async command => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-desktop-cli-')); roots.push(root);
    const resources = join(root, 'resources'); await mkdir(resources);
    await writeFile(join(resources, 'trusted-release-keys.json'), '{}');
    vi.stubEnv('METAWORK_INTERNAL_LLM_SOURCE_ROOT', join(root, 'missing-developer-home'));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runDesktopInstall([command, resources, join(root, 'installation'), '0.1.5'], Readable.from([
      JSON.stringify({ baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', modelId: 'fixture-model' }),
    ]));
    expect(command === 'install' ? mocks.install : mocks.update).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
    await expect(access(join(root, 'installation/internal'))).rejects.toThrow();
    if (command === 'install') expect(mocks.release).toHaveBeenCalledOnce();
  });
});
