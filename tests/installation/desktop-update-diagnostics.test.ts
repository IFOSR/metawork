import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopUpdateDiagnostics, readDesktopUpdateDiagnostic } from '../../src/installation/desktop-update-diagnostics.js';
import type { DesktopActivationPort } from '../../src/installation/desktop-activation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'update-diagnostic-')); roots.push(root);
  const observer = new DesktopUpdateDiagnostics(root, 'update');
  const port = Object.fromEntries(['verify', 'stop', 'updateRuntime', 'replaceShell', 'startAndVerifyCandidate',
    'restoreRuntime', 'restoreShell', 'startPrevious'].map(name => [name, vi.fn(async () => {})])) as unknown as DesktopActivationPort;
  return { root, observer, port };
}
it('retains the failed stage after a successful rollback without logging exception contents', async () => {
  const { root, observer, port } = await setup();
  port.startAndVerifyCandidate = async () => { throw new Error('secret-provider-key/path/ticket'); };
  const observed = observer.observe(port);
  await expect(observed.startAndVerifyCandidate()).rejects.toThrow();
  await observed.restoreRuntime(); await observed.restoreShell(); await observed.startPrevious();
  await observer.finish('rolled-back');
  expect(await readDesktopUpdateDiagnostic(root)).toMatchObject({ outcome: 'rolled-back',
    failures: [{ stage: 'startAndVerifyCandidate', code: 'unexpected' }] });
  expect(await readFile(join(root, 'upgrades/desktop-update-status.json'), 'utf8')).not.toContain('secret-provider-key');
});
it('reports safe runtime readiness failure and a second recovery failure', async () => {
  const { root, observer, port } = await setup();
  port.startAndVerifyCandidate = async () => { throw new Error('后台服务未能就绪，请检查安装与服务日志。'); };
  port.restoreRuntime = async () => { throw Object.assign(new Error('private backup path'), { code: 'ENOSPC' }); };
  const observed = observer.observe(port);
  await expect(observed.startAndVerifyCandidate()).rejects.toThrow();
  await expect(observed.restoreRuntime()).rejects.toThrow();
  await observer.finish('failed');
  expect((await readDesktopUpdateDiagnostic(root))?.failures).toEqual([
    { stage: 'startAndVerifyCandidate', code: 'runtime-not-ready' }, { stage: 'restoreRuntime', code: 'ENOSPC' },
  ]);
});
it('does not block recovery when diagnostics cannot be written', async () => {
  const { root, observer, port } = await setup();
  await writeFile(join(root, 'upgrades'), 'not a directory');
  await observer.observe(port).restoreRuntime();
  expect(port.restoreRuntime).toHaveBeenCalledOnce();
  await observer.finish('rolled-back');
});
it('rejects unrecognized diagnostic values and omits arbitrary extra fields', async () => {
  const { root, observer } = await setup();
  await observer.finish('committed');
  const path = join(root, 'upgrades/desktop-update-status.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...value, credential: 'secret' }));
  expect(await readDesktopUpdateDiagnostic(root)).not.toHaveProperty('credential');
  await writeFile(path, JSON.stringify({ ...value, failures: [{ stage: 'verify', code: 'untrusted body' }] }));
  expect(await readDesktopUpdateDiagnostic(root)).toBeNull();
});
