import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopActivation } from '../../src/installation/desktop-activation.js';
import { runDesktopUpdateTransaction } from '../../src/installation/desktop-update-transaction.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-update-')); roots.push(root);
  const lock = join(root, 'desktop-helper.lock');
  const journal = join(root, 'desktop-activation.json');
  await writeFile(lock, String(process.pid));
  const port = { verify: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    updateRuntime: vi.fn(async () => {}), replaceShell: vi.fn(async () => {}),
    startAndVerifyCandidate: vi.fn(async () => {}), restoreRuntime: vi.fn(async () => {}),
    restoreShell: vi.fn(async () => {}), startPrevious: vi.fn(async () => {}) };
  const activation = new DesktopActivation(journal, port);
  const record = { previousReleaseId: '0.1.5', candidateReleaseId: '0.1.7',
    applicationPath: '/Applications/MetaWork.app', stagedApplicationPath: '/stage/MetaWork.app',
    backupApplicationPath: '/Applications/MetaWork.app.backup' };
  const input = { activation, record, recoverOnly: false, candidateRunning: () => true,
    finalize: vi.fn(async () => {}),
    releaseLock: async () => { await rm(lock); },
    relaunch: vi.fn(() => { expect(existsSync(lock)).toBe(false); }) };
  return { input, port, journal, lock };
}

it('reopens the restored Desktop only after releasing the live helper lock', async () => {
  const { input, port } = await fixture();
  port.startAndVerifyCandidate.mockRejectedValue(new Error('Candidate health failed'));
  await expect(runDesktopUpdateTransaction(input)).rejects.toThrow('Candidate health failed');
  expect((await input.activation.read())?.phase).toBe('rolled-back');
  expect(input.finalize).not.toHaveBeenCalled();
  expect(input.relaunch).toHaveBeenCalledOnce();
  expect(port.startPrevious).toHaveBeenCalledOnce();
});

it.each(['rolled-back', 'committed'])('repair of a %s update does not apply the old request again', async phase => {
  const { input, port, journal } = await fixture();
  await writeFile(journal, JSON.stringify({ ...input.record, schemaVersion: 1, phase }));
  await runDesktopUpdateTransaction({ ...input, recoverOnly: true });
  expect(port.verify).not.toHaveBeenCalled();
  expect(port.updateRuntime).not.toHaveBeenCalled();
  expect(port.restoreRuntime).not.toHaveBeenCalled();
  expect(input.finalize).not.toHaveBeenCalled();
  expect(input.relaunch).toHaveBeenCalledOnce();
});

it('repairs an interrupted activation before reopening the restored Desktop', async () => {
  const { input, port, journal } = await fixture();
  await writeFile(journal, JSON.stringify({ ...input.record, schemaVersion: 1, phase: 'shell-replaced' }));
  await runDesktopUpdateTransaction({ ...input, recoverOnly: true });
  expect(port.updateRuntime).not.toHaveBeenCalled();
  expect(port.restoreRuntime).toHaveBeenCalledOnce();
  expect((await input.activation.read())?.phase).toBe('rolled-back');
  expect(input.relaunch).toHaveBeenCalledOnce();
});

it('retains failed recovery without reopening a mismatched Desktop', async () => {
  const { input, port, journal, lock } = await fixture();
  await writeFile(journal, JSON.stringify({ ...input.record, schemaVersion: 1, phase: 'shell-replaced' }));
  port.restoreRuntime.mockRejectedValue(new Error('Missing backup companion'));
  await expect(runDesktopUpdateTransaction({ ...input, recoverOnly: true })).rejects.toThrow('Missing backup companion');
  expect((await input.activation.read())?.phase).toBe('shell-replaced');
  expect(input.relaunch).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(false);
});

it('does not reopen a second Desktop after the candidate commits', async () => {
  const { input } = await fixture();
  await runDesktopUpdateTransaction(input);
  expect((await input.activation.read())?.phase).toBe('committed');
  expect(input.finalize).toHaveBeenCalledOnce();
  expect(input.relaunch).not.toHaveBeenCalled();
});

it('rejects recovery for a different activation before mutating the runtime', async () => {
  const { input, port, journal } = await fixture();
  await writeFile(journal, JSON.stringify({ ...input.record, candidateReleaseId: 'other', schemaVersion: 1, phase: 'prepared' }));
  await expect(runDesktopUpdateTransaction({ ...input, recoverOnly: true })).rejects.toThrow('does not match');
  expect(port.restoreRuntime).not.toHaveBeenCalled();
  expect(input.relaunch).not.toHaveBeenCalled();
});
