import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureMacOSServerProcess, finishMacOSServerExit } from '../../src/installation/macos-server-exit.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: async (...args: unknown[]) => ({ stdout: await mocks.execute(...args), stderr: '' }),
}) }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'server-exit-'))); roots.push(root);
  await mkdir(join(root, 'data'));
  const args = [join(root, 'desktop-support/previous/desktop-tools/node/bin/node'), join(root, 'app/releases/previous/dist/index.js'), 'server', 'start'];
  const state = { pid: 12345, alive: true, birth: 'Sat Oct 17 11:38:00 2026', args,
    files: 'p12345\nftxt\ntREG\nn/node\n', uid: process.getuid!(), fail: false, retired: false, zombie: false };
  mocks.execute.mockImplementation(async (command, argv) => {
    if (state.fail) throw Object.assign(new Error('launchctl denied'), { code: 1 });
    if (command === '/bin/launchctl' && (!state.alive || state.retired)) return 'state = not running';
    if (command === '/bin/launchctl') return `arguments = {\n${state.args.join('\n')}\n}\npid = ${state.pid}\n`;
    if (command === '/bin/ps') {
      if (!state.alive) throw Object.assign(new Error('gone'), { code: 1 });
      return `${state.uid} ${state.birth} ${state.zombie ? 'Z' : 'S'} ${state.retired || state.zombie ? '(node)' : state.args.join(' ')}`;
    }
    if (command === '/usr/sbin/lsof') return state.files;
    throw new Error(`Unexpected ${command} ${argv}`);
  });
  const signal = vi.fn(() => { state.alive = false; });
  const sleep = vi.fn(async () => undefined);
  return { root, state, signal, sleep };
}

it('finishes a legacy exit hang after lock and endpoint removal, then verifies process exit', async () => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  expect(server).not.toBeNull();
  await finishMacOSServerExit(server!, { ...f, timeoutMs: 400 });
  expect(f.sleep).toHaveBeenCalledTimes(2);
  expect(f.signal).toHaveBeenCalledOnce();
  expect(f.signal).toHaveBeenCalledWith(12345, 'SIGKILL');
});

it('allows normal graceful exit without forcing it', async () => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  f.sleep.mockImplementation(async () => { f.state.alive = false; });
  await finishMacOSServerExit(server!, { ...f, timeoutMs: 400 });
  expect(f.signal).not.toHaveBeenCalled();
});

it.each(['data/runtime.lock', 'server-endpoint.json'])('never forces a Server retaining %s', async path => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  await writeFile(join(f.root, path), '{}');
  await expect(finishMacOSServerExit(server!, { ...f, timeoutMs: 0 })).rejects.toThrow('not completed shutdown');
  expect(f.signal).not.toHaveBeenCalled();
});

it.each(['tIPv4', 'tIPv6', 'tunix', 'n/accounts/local/data/anyfusion.db', 'n/data/runtime.db'])('never forces a process holding resources: %s', async file => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  f.state.files += file.startsWith('n') ? `n${f.root}${file.slice(1)}\n` : `${file}\n`;
  await expect(finishMacOSServerExit(server!, { ...f, timeoutMs: 0 })).rejects.toThrow('holds runtime resources');
  expect(f.signal).not.toHaveBeenCalled();
});

it.each(['birth', 'pid', 'args'])('rejects process replacement or PID reuse (%s)', async field => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  if (field === 'birth') f.state.birth = 'Sat Oct 17 12:38:00 2026';
  if (field === 'pid') f.state.pid++;
  if (field === 'args') f.state.args[1] = '/unrelated.js';
  await expect(finishMacOSServerExit(server!, { ...f, timeoutMs: 0 })).rejects.toThrow('changed during stop');
  expect(f.signal).not.toHaveBeenCalled();
});

it.each(['uid', 'entry', 'node'])('rejects a foreign job (%s)', async field => {
  const f = await fixture();
  if (field === 'uid') f.state.uid++;
  if (field === 'entry') f.state.args[1] = '/other/app/releases/previous/dist/index.js';
  if (field === 'node') f.state.args[0] = '/usr/bin/node';
  await expect(captureMacOSServerProcess(f.root)).rejects.toThrow('identity mismatch');
});

it('fails closed on launchctl errors but accepts an absent job', async () => {
  const f = await fixture(); f.state.fail = true;
  await expect(captureMacOSServerProcess(f.root)).rejects.toThrow('denied');
  mocks.execute.mockRejectedValue(Object.assign(new Error('no service'), { code: 113 }));
  expect(await captureMacOSServerProcess(f.root)).toBeNull();
});

it('fails if the forced process still does not exit', async () => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  f.signal.mockImplementation(() => undefined);
  await expect(finishMacOSServerExit(server!, { ...f, timeoutMs: 0 })).rejects.toThrow('did not exit');
});


it.each(['retired', 'zombie'])('handles macOS process reaping without mistaking it for PID reuse (%s)', async mode => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  f.signal.mockImplementation(() => { f.state.retired = true; f.state.zombie = mode === 'zombie'; });
  f.sleep.mockImplementation(async () => { f.state.alive = false; });
  await finishMacOSServerExit(server!, { ...f, timeoutMs: 0 });
  expect(f.signal).toHaveBeenCalledOnce();
});

it('rechecks withdrawn facts after inspecting process resources', async () => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  const original = mocks.execute.getMockImplementation()!;
  mocks.execute.mockImplementation(async (command, args, options) => {
    if (command === '/usr/sbin/lsof') await writeFile(join(f.root, 'data/runtime.lock'), '{}');
    return original(command, args, options);
  });
  await expect(finishMacOSServerExit(server!, { ...f, timeoutMs: 0 })).rejects.toThrow('not completed shutdown');
  expect(f.signal).not.toHaveBeenCalled();
});


it('waits when launchd releases its PID between the ps and launchd observations', async () => {
  const f = await fixture();
  const server = await captureMacOSServerProcess(f.root);
  const original = mocks.execute.getMockImplementation()!;
  let retired = false;
  mocks.execute.mockImplementation(async (command, args, options) => {
    if (command === '/bin/launchctl' && retired) return 'state = not running';
    return original(command, args, options);
  });
  f.signal.mockImplementation(() => { retired = true; });
  f.sleep.mockImplementation(async () => { f.state.alive = false; });
  await finishMacOSServerExit(server!, { ...f, timeoutMs: 0 });
  expect(f.signal).toHaveBeenCalledOnce();
});
