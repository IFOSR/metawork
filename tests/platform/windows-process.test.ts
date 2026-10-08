import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsOwnedProcess, createWindowsProcessSpawner, loadWindowsProcesses, quoteWindowsArgument, windowsEnvironmentBlock } from '../../src/platform/windows-process.js';
import { WindowsPipeStream } from '../../src/platform/windows-pipe.js';
import { PlannerProcessSupervisor } from '../../src/planning/planner-process-supervisor.js';
import { SpawnLocalCliChildProcessRunner } from '../../src/executor/local-cli-executor-adapter.js';

it('quotes Windows argv without a shell and rejects ambiguous environment keys', () => {
  expect(quoteWindowsArgument('')).toBe('""');
  expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
  expect(quoteWindowsArgument('C:\\folder\\')).toBe('"C:\\folder\\\\"');
  expect(() => quoteWindowsArgument('a\0b')).toThrow('NUL');
  expect(() => windowsEnvironmentBlock({ PATH: 'one', Path: 'two' })).toThrow('Duplicate');
  expect(windowsEnvironmentBlock({ Z: '末尾', A: 'first', missing: undefined })).toBe('A=first\0Z=末尾\0\0');
});

describe.skipIf(process.platform !== 'win32')('owned native Windows processes', () => {
  const active: WindowsOwnedProcess[] = [];
  const roots: string[] = [];
  function launch(args: string[], cwd = process.cwd()) {
    const child = new WindowsOwnedProcess(loadWindowsProcesses(resolve('native/windows/build/Release/metawork_platform.node')),
      { executable: process.execPath, args, cwd, env: { SystemRoot: process.env.SystemRoot, fixture: '环境 value' } });
    active.push(child);
    return child;
  }
  afterEach(async () => {
    for (const child of active.splice(0)) {
      child.stdout.resume(); child.stderr.resume();
      const done = once(child, 'close');
      if (child.kill('SIGKILL')) await done;
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('round-trips argv, Unicode environment and bounded stdio through a real Node process', async () => {
    const args = ['', '中文 spaces', 'C:\\trailing\\', 'one"two', 'three\\"four', '$(not-a-shell) & ^ |'];
    const child = launch(['-e', `process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.fixture})+'\\n');
      process.stdin.pipe(process.stdout); process.stderr.write('diagnostic');`, '--', ...args]);
    expect(child.stdout).not.toBeInstanceOf(WindowsPipeStream);
    const done = once(child, 'close');
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.on('data', bytes => errors.push(bytes));
    const input = Buffer.alloc(2 * 1024 * 1024, 97);
    child.stdin.end(input);
    expect(await done).toEqual([0, null]);
    const bytes = Buffer.concat(output), separator = bytes.indexOf(10);
    expect(JSON.parse(bytes.subarray(0, separator).toString())).toEqual({ args, value: '环境 value' });
    expect(bytes.subarray(separator + 1)).toEqual(input);
    expect(Buffer.concat(errors).toString()).toBe('diagnostic');
  }, 20_000);

  it('pauses, resumes and cancels the complete tree while retaining an unrelated process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mw-owned-process-')); roots.push(root);
    const leaf = `const fs=require('node:fs'); fs.writeFileSync('leaf.pid',String(process.pid));
      setInterval(()=>fs.appendFileSync('leaf.tick','.'),10);`;
    const child = launch(['-e', `const {spawn}=require('node:child_process');
      spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});
      setInterval(()=>require('node:fs').appendFileSync('root.tick','.'),10);`], root);
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    const unrelated = launch(['-e', 'setInterval(()=>{},1000)']);
    unrelated.stdout.resume(); unrelated.stderr.resume(); unrelated.stdin.end();
    const deadline = Date.now() + 5000;
    while (!(await stat(join(root, 'leaf.tick')).catch(() => null)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const pid = Number(await readFile(join(root, 'leaf.pid'), 'utf8'));
    await child.pause(); await child.pause();
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = await Promise.all(['leaf.tick', 'root.tick'].map(name => stat(join(root, name)).then(info => info.size)));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await Promise.all(['leaf.tick', 'root.tick'].map(name => stat(join(root, name)).then(info => info.size)))).toEqual(before);
    await child.resume(); await child.resume();
    await new Promise(resolve => setTimeout(resolve, 150));
    const after = await Promise.all(['leaf.tick', 'root.tick'].map(name => stat(join(root, name)).then(info => info.size)));
    expect(after.every((value, i) => value > before[i]!)).toBe(true);
    const done = once(child, 'close'); child.kill('SIGTERM');
    expect(await done).toEqual([null, 'SIGTERM']);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
  }, 20_000);

  it('launches an installed Planner JavaScript entry through the Server Node executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mw-planner-job-')); roots.push(root);
    const command = join(root, '中文 planner.cjs');
    await writeFile(command, "if(process.argv[2]!=='--version')process.exit(2);console.log('planner-entry-ok');");
    const native = loadWindowsProcesses(resolve('native/windows/build/Release/metawork_platform.node'));
    const supervisor = new PlannerProcessSupervisor({ command, cwd: root, plannerHome: root,
      windowsSpawn: createWindowsProcessSpawner(native) });
    try { expect(await supervisor.probe()).toEqual({ available: true, detail: 'planner-entry-ok' }); }
    finally { await supervisor.stop(); }
  });

  it('keeps the Executor cancellation receipt pending until its descendant has exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mw-executor-job-')); roots.push(root);
    const native = loadWindowsProcesses(resolve('native/windows/build/Release/metawork_platform.node'));
    const runner = new SpawnLocalCliChildProcessRunner({ windowsSpawn: createWindowsProcessSpawner(native) });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const leaf = `require('node:fs').writeFileSync('descendant.pid',String(process.pid)); setInterval(()=>{},1000);`;
    const result = runner.run({ attemptId: 'owned-attempt', command: process.execPath,
      args: ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});
        const t=setInterval(()=>{ if(require('node:fs').existsSync('descendant.pid')) { clearInterval(t); console.log('ready'); } },10);
        setInterval(()=>{},1000);`], cwd: root, environment: {}, onLine: line => { if (line === 'ready') ready(); } });
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([started, result.then(() => { throw new Error('Executor exited before readiness'); }),
        new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('Executor readiness timed out')), 5000); })]);
      const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
      runner.abort('owned-attempt');
      expect((await result).diagnostics?.terminationSource).toBe('abort');
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally { if (readyTimer) clearTimeout(readyTimer); runner.abort(); await result; }
  }, 20_000);
});
