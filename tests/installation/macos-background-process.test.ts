import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startMacOSBackgroundProcess } from '../../src/installation/macos-background-process.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: async (...args: unknown[]) => ({ stdout: await mocks.execute(...args), stderr: '' }),
}) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-launchd-')); roots.push(root);
  return { root, role: 'update' as const, executable: '/node', args: ['/helper', 'spaces & <data>'],
    cwd: root, env: { FIXTURE: 'value & "quoted"' }, logPath: join(root, 'helper.log') };
}

it('launches a one-shot job without retaining its environment or registering a login item', async () => {
  const input = await fixture();
  mocks.execute.mockImplementation(async (_command, args) => {
    if (args[0] === 'print') throw new Error('not registered');
    expect(args[0]).toBe('bootstrap');
    const plist = await readFile(args[2], 'utf8');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>AbandonProcessGroup</key><true/>');
    expect(plist).toContain('<string>spaces &amp; &lt;data&gt;</string>');
    expect(plist).toContain('value &amp; &quot;quoted&quot;');
    return '';
  });
  await startMacOSBackgroundProcess(input);
  expect(await readdir(join(input.root, 'desktop-support'))).toEqual([]);
});

it('never stops a live job to launch another helper', async () => {
  const input = await fixture();
  mocks.execute.mockResolvedValue('state = running\n\tpid = 12345\n');
  await expect(startMacOSBackgroundProcess(input)).rejects.toThrow('already running');
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it('lets concurrent clients wait for the existing Server readiness check', async () => {
  const input = await fixture();
  mocks.execute.mockResolvedValue('state = running\n\tpid = 12345\n');
  await startMacOSBackgroundProcess({ ...input, role: 'server' });
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it('retires a finished job before the next update and fails closed if launchd refuses it', async () => {
  const input = await fixture();
  mocks.execute.mockImplementation(async (_command, args) => {
    if (args[0] === 'print') return 'state = not running\nlast exit code = 0\n';
    if (args[0] === 'bootstrap') throw new Error('launch denied');
    return '';
  });
  await expect(startMacOSBackgroundProcess(input)).rejects.toThrow('launch denied');
  expect(mocks.execute.mock.calls.map(call => call[1][0])).toEqual(['print', 'bootout', 'bootstrap']);
  expect(await readdir(join(input.root, 'desktop-support'))).toEqual([]);
});
