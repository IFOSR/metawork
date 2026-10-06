import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeDesktopShellCheck, waitForDesktopShellHealth, writeDesktopShellHealth } from '../../src/installation/desktop-shell-health.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-health-')); roots.push(root);
  await mkdir(join(root, 'upgrades'));
  return root;
}
const expected = { challenge: randomUUID(), releaseId: '2.0.0', instanceId: 'server-instance', pid: 1234 };
describe('Desktop activation shell receipt', () => {
  it('requires the new shell, authenticated instance and activation challenge to match', async () => {
    const root = await fixture();
    for (const mismatch of [{ challenge: randomUUID() }, { instanceId: 'previous-instance' }, { pid: 4321 }, { releaseId: '1.0.0' }]) {
      await writeDesktopShellHealth(root, { ...expected, ...mismatch });
      await expect(waitForDesktopShellHealth(root, expected, { alive: () => true, timeoutMs: 0 })).rejects.toThrow('readiness');
    }
    await writeDesktopShellHealth(root, expected);
    await expect(waitForDesktopShellHealth(root, expected, { alive: () => true })).resolves.toBeUndefined();
    await expect(waitForDesktopShellHealth(root, expected, { alive: () => false })).rejects.toThrow('exited');
  });
  it('allows a pending activation only for its candidate application after shell replacement', async () => {
    const root = await fixture();
    const record = { candidateReleaseId: expected.releaseId, applicationPath: '/Applications/MetaWork.app', backupApplicationPath: '/backup' };
    const input = { challenge: expected.challenge, applicationPath: record.applicationPath, releaseId: expected.releaseId };
    await writeFile(join(root, 'upgrades/desktop-request.json'), JSON.stringify({ shellChallenge: expected.challenge, record }));
    for (const phase of ['prepared', 'runtime-updated', 'committed', 'rolled-back']) {
      await writeFile(join(root, 'upgrades/desktop-activation.json'), JSON.stringify({ ...record, phase }));
      await expect(authorizeDesktopShellCheck(root, input)).resolves.toBe(false);
    }
    await writeFile(join(root, 'upgrades/desktop-activation.json'), JSON.stringify({ ...record, phase: 'shell-replaced' }));
    await expect(authorizeDesktopShellCheck(root, input)).resolves.toBe(true);
    await expect(authorizeDesktopShellCheck(root, { ...input, applicationPath: '/Another.app' })).resolves.toBe(false);
    await expect(authorizeDesktopShellCheck(root, { ...input, challenge: randomUUID() })).resolves.toBe(false);
  });
});
