import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SpawnLocalCliChildProcessRunner } from '../../src/executor/local-cli-executor-adapter.js';
import { NativeAttemptExecutionBackend } from '../../src/execution/native-attempt-execution-backend.js';
import { runMigrations } from '../../src/storage/migrations.js';

const posix = process.platform !== 'win32';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A command that leaves one background child in the same process group. */
const LEAK = 'sleep 30 & echo $!; exit 0';

describe('Attempt process-group ownership', () => {
  it.skipIf(!posix)('reaps a background child the Executor CLI left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-group-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const runner = new SpawnLocalCliChildProcessRunner({ residualGraceMs: 500 });

    const result = await runner.run({
      attemptId: 'attempt-group-leak',
      command: '/bin/sh',
      args: ['-c', LEAK],
      cwd: root,
      environment: {},
    });

    const childPid = Number(result.stdout.trim());
    expect(Number.isInteger(childPid)).toBe(true);
    expect(result.exitCode).toBe(0);
    const residual = result.diagnostics?.residualGroup;
    expect(residual).toMatchObject({ reaped: true, signalled: 'SIGTERM' });
    expect(residual?.members).toEqual([expect.objectContaining({ pid: childPid, command: 'sleep' })]);
    expect(pidAlive(childPid)).toBe(false);
  }, 20_000);

  it.skipIf(!posix)('pays nothing when the Attempt cleaned up after itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-group-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const runner = new SpawnLocalCliChildProcessRunner({ residualGraceMs: 5_000 });

    const startedAt = Date.now();
    const result = await runner.run({
      attemptId: 'attempt-group-clean',
      command: '/bin/sh',
      args: ['-c', 'echo done'],
      cwd: root,
      environment: {},
    });
    const elapsed = Date.now() - startedAt;

    expect(result.stdout.trim()).toBe('done');
    expect(result.diagnostics?.residualGroup).toBeUndefined();
    expect(elapsed).toBeLessThan(2_000);
  }, 20_000);

  it.skipIf(!posix)('reaps the group of an in-place backend attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-backend-group-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const db = new Database(join(root, 'state.db'));
    runMigrations(db);
    cleanups.push(async () => db.close());
    const backend = new NativeAttemptExecutionBackend();

    const created = await backend.create({
      attemptId: 'attempt-backend-group',
      taskId: 'task_1',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      workUnitId: 'work-unit-1',
      leaseToken: 'lease-1',
      idempotencyKey: 'idempotency-1',
      imageRef: 'executor-profile',
      resolvedImageId: 'sha256:profile',
      command: '/bin/sh',
      args: ['-c', LEAK],
      environment: {},
      mounts: [{ source: root, target: '/workspace', mode: 'rw' }],
      controlNetwork: 'none',
      egressMode: 'disabled',
      limits: { cpus: 1, memoryBytes: 1, pids: 8, tmpfsBytes: 1, logSize: '1m', logFiles: 1 },
    });
    await backend.start(created.containerId);
    const exitCode = await backend.wait(created.containerId);
    const logs = await backend.logs(created.containerId);
    const record = await backend.inspect(created.containerId);

    expect(exitCode).toBe(0);
    const childPid = Number(logs.trim().split('\n')[0]);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(logs).toContain('reaped 1 residual process(es)');
    expect(record?.residualProcesses).toEqual([expect.objectContaining({ pid: childPid, command: 'sleep' })]);
    expect(pidAlive(childPid)).toBe(false);
  }, 20_000);
  it.skipIf(!posix)('recovers a live native process from durable identity before releasing its files', async () => {
    const root=await mkdtemp(join(tmpdir(),'metawork-native-recovery-'));
    cleanups.push(()=>rm(root,{recursive:true,force:true}));
    const state=join(root,'processes');
    const backend=new NativeAttemptExecutionBackend(state);
    const created=await backend.create({
      attemptId:'recovered',taskId:'t',generationId:'g',subtaskId:'s',workUnitId:'w',
      leaseToken:'lease',idempotencyKey:'key',imageRef:'native',resolvedImageId:'sha256:test',
      command:'/bin/sh',args:['-c','echo $$ > owner; exec sleep 30'],environment:{},
      mounts:[{source:root,target:'/workspace',mode:'rw'}],controlNetwork:'none',egressMode:'disabled',
      limits:{cpus:1,memoryBytes:1,pids:8,tmpfsBytes:1,logSize:'1m',logFiles:1},
    });
    cleanups.push(()=>backend.stop(created.containerId));
    await backend.start(created.containerId);
    let pid=0;
    for(let i=0;i<200&&!pid;i++) {
      pid=await readFile(join(root,'owner'),'utf8').then(Number,()=>0);
      if(!pid)await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(pid).toBeGreaterThan(1);
    const recovered=new NativeAttemptExecutionBackend(state);
    expect(await recovered.listManaged()).toEqual([expect.objectContaining({status:'running'})]);
    await recovered.stop(created.containerId);
    expect(pidAlive(pid)).toBe(false);
    expect(await recovered.inspect(created.containerId)).toMatchObject({status:'exited'});
    await recovered.remove(created.containerId);
    expect(await recovered.listManaged()).toEqual([]);
  },20_000);

  it.skipIf(!posix)('fences a delayed launch after an unstarted receipt is recovered', async () => {
    const root=await mkdtemp(join(tmpdir(),'metawork-native-fence-'));
    cleanups.push(()=>rm(root,{recursive:true,force:true}));
    const state=join(root,'processes');
    const backend=new NativeAttemptExecutionBackend(state);
    const created=await backend.create({
      attemptId:'unstarted',taskId:'t',generationId:'g',subtaskId:'s',workUnitId:'w',
      leaseToken:'lease',idempotencyKey:'key',imageRef:'native',resolvedImageId:'sha256:test',
      command:'/bin/sh',args:['-c','echo unsafe > launched'],environment:{},
      mounts:[{source:root,target:'/workspace',mode:'rw'}],controlNetwork:'none',egressMode:'disabled',
      limits:{cpus:1,memoryBytes:1,pids:8,tmpfsBytes:1,logSize:'1m',logFiles:1},
    });
    const recovered=new NativeAttemptExecutionBackend(state);
    expect(await recovered.inspect(created.containerId)).toMatchObject({status:'missing'});
    await backend.start(created.containerId);
    await backend.wait(created.containerId);
    expect(await readFile(join(root,'launched'),'utf8').catch(()=>null)).toBeNull();
    await writeFile(join(root,'sentinel'),'preserved');
  },20_000);

});
