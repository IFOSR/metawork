import { expect, it, vi } from 'vitest';
import { findInstalledServerProcesses } from '../../src/management/server-process-scan.js';

const root = '/Users/example/.metawork';
const uid = 501;

function ps(...commands: Array<{ pid: number; uid?: number; command: string }>): string {
  return commands.map(entry => `${entry.pid} ${entry.uid ?? uid} ${entry.command}`).join('\n');
}

const serverCommand = (release: string) => `${root}/desktop-support/x/node/bin/node ${root}/app/releases/${release}/dist/index.js server start`;

it('finds orphaned Servers of this installation owned by this user', async () => {
  const execute = vi.fn(async () => ({ stdout: ps(
    { pid: 100, command: serverCommand('0.1.22-local-1') },
    { pid: 101, command: serverCommand('0.1.23-local-2') },
  ), stderr: '' }));
  expect(await findInstalledServerProcesses(root, { execute: execute as never, uid, selfPid: 999 })).toEqual([100, 101]);
  expect(execute).toHaveBeenCalledWith('/bin/ps', ['-Ao', 'pid=,uid=,command='], { timeout: 5_000 });
});

it('ignores other users, other roots, other argv and itself', async () => {
  const execute = vi.fn(async () => ({ stdout: ps(
    { pid: 100, uid: uid + 1, command: serverCommand('r1') },
    { pid: 101, command: '/opt/other/app/releases/r2/dist/index.js server start' },
    { pid: 102, command: `${root}/app/releases/r3/dist/index.js server stop` },
    { pid: 103, command: `${root}/app/releases/r4/dist/index.js doctor` },
    { pid: uid, command: serverCommand('r5') },
    { pid: 104, command: `node ${root}/app/releases/../../escape/dist/index.js server start` },
  ), stderr: '' }));
  expect(await findInstalledServerProcesses(root, { execute: execute as never, uid, selfPid: uid })).toEqual([]);
});

it('never scans on Windows or without a uid', async () => {
  const execute = vi.fn();
  expect(await findInstalledServerProcesses(root, { execute: execute as never, platform: 'win32', uid })).toEqual([]);
  expect(await findInstalledServerProcesses(root, { execute: execute as never, uid: null })).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});

it('fails closed when the process table cannot be read', async () => {
  const execute = vi.fn(async () => { throw new Error('ps failed'); });
  await expect(findInstalledServerProcesses(root, { execute: execute as never, uid })).rejects.toThrow('ps failed');
});
