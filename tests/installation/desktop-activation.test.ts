import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopActivation, type DesktopActivationPort } from '../../src/installation/desktop-activation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Shell and native runtime activation', () => {
  const input = { previousReleaseId: '1.0.0', candidateReleaseId: '1.1.0', applicationPath: '/Applications/MetaWork.app',
    stagedApplicationPath: '/staged/MetaWork.app', backupApplicationPath: '/backup/MetaWork.app' };
  async function setup(failure?: keyof DesktopActivationPort) {
    const root = await mkdtemp(join(tmpdir(), 'desktop-activation-')); roots.push(root);
    const calls: string[] = [];
    const port = Object.fromEntries(['verify', 'stop', 'updateRuntime', 'replaceShell', 'startAndVerifyCandidate',
      'restoreRuntime', 'restoreShell', 'startPrevious'].map(name => [name, async () => {
      calls.push(name); if (failure === name) throw new Error(`failed ${name}`);
    }])) as unknown as DesktopActivationPort;
    return { activation: new DesktopActivation(join(root, 'activation.json'), port), calls, port, root };
  }
  it('commits only after candidate identity and health have been checked', async () => {
    const { activation, calls } = await setup(); await activation.apply(input);
    expect(calls).toEqual(['verify', 'stop', 'updateRuntime', 'replaceShell', 'startAndVerifyCandidate']);
    expect((await activation.read())?.phase).toBe('committed');
    await activation.recover(); expect(calls).toHaveLength(5);
  });
  it.each(['updateRuntime', 'replaceShell', 'startAndVerifyCandidate'] as const)('restores both components after %s failure', async failure => {
    const { activation, calls } = await setup(failure);
    await expect(activation.apply(input)).rejects.toThrow(failure);
    expect(calls.slice(-4)).toEqual(['stop', 'restoreRuntime', 'restoreShell', 'startPrevious']);
    expect((await activation.read())?.phase).toBe('rolled-back');
  });
  it('keeps a recoverable record when journal companion verification rejects rollback', async () => {
    const { activation, calls, port } = await setup('startAndVerifyCandidate');
    port.restoreRuntime = async () => { throw new Error('missing companion'); };
    await expect(activation.apply(input)).rejects.toThrow('missing companion');
    expect((await activation.read())?.phase).toBe('shell-replaced');
    expect(calls).not.toContain('restoreShell');
    port.restoreRuntime = async () => { calls.push('verified restore'); };
    await activation.recover(); expect((await activation.read())?.phase).toBe('rolled-back');
  });
  it.each(['prepared', 'runtime-updated', 'shell-replaced'])('recovers persisted %s after helper restart without trusting the candidate', async phase => {
    const { activation, calls, root } = await setup();
    await writeFile(join(root, 'activation.json'), JSON.stringify({ ...input, schemaVersion: 1, phase }));
    await activation.recover();
    expect(calls).toEqual(['stop', 'restoreRuntime', 'restoreShell', 'startPrevious']);
    expect((await activation.read())?.phase).toBe('rolled-back');
  });
});
