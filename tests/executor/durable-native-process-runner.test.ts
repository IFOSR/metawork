import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAttemptExecutionBackend } from '../../src/execution/native-attempt-execution-backend.js';
import type { AttemptExecutionPersistenceRecord, AttemptExecutionRepositoryPort } from '../../src/execution/repositories.js';
import { DurableNativeProcessRunner } from '../../src/executor/durable-native-process-runner.js';
import type { LocalCliChildProcessInput } from '../../src/executor/local-cli-executor-adapter.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-durable-runner-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'receipts');
  const backend = new NativeAttemptExecutionBackend(stateRoot);
  const rows = new Map<string, AttemptExecutionPersistenceRecord>();
  const repository: AttemptExecutionRepositoryPort = {
    create: record => { rows.set(record.attemptId, record); return record; },
    find: id => rows.get(id) ?? null,
    findByContainerId: id => [...rows.values()].find(row => row.containerId === id) ?? null,
    listActive: () => [...rows.values()].filter(row => ['running', 'created', 'paused'].includes(row.status)),
    update: (id, changes) => { const row = rows.get(id); if (row) rows.set(id, { ...row, ...changes }); },
  };
  const runner = new DurableNativeProcessRunner(backend, repository);
  cleanups.push(async () => {
    for (const record of await backend.listManaged()) await backend.stop(record.containerId);
  });
  const input: LocalCliChildProcessInput = {
    attemptId: 'a', command: process.execPath, args: ['-e', 'console.log("done")'],
    cwd: root, environment: {},
    executionBinding: {
      attemptId: 'a', taskId: 't', generationId: 'g', subtaskId: 's', workUnitId: 'w',
      leaseToken: 'lease', idempotencyKey: 'key', workspaceId: 'workspace',
      workspacePath: root, sourcePath: root, inputsPath: root, handoffsPath: root,
      gitMetadataPath: null, controlNetwork: 'native', capabilityBinding: null,
    },
  };
  return { root, stateRoot, backend, runner, input, repository };
}

describe('durable native Pi process ownership', () => {
  it('persists before launch, forwards output once, and cannot launch the same Attempt twice', async () => {
    const { runner, input, repository, backend } = await fixture();
    const output = vi.fn();
    input.onLine = output;
    input.executionBinding!.onExecutionCreated = () => {
      expect(repository.find('a')).toMatchObject({ status: 'created' });
    };
    expect(await runner.run(input)).toMatchObject({ exitCode: 0, stdout: 'done\n' });
    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith('done', 'stdout');
    expect(repository.find('a')).toMatchObject({ status: 'removed', cleanupStatus: 'removed', exitCode: 0 });
    expect(await backend.listManaged()).toEqual([]);
    await expect(runner.run(input)).rejects.toThrow('native_attempt_already_created');
  });

  it('supports pause/resume through the shared backend and recovery through durable receipts', async () => {
    const { runner, input, backend, stateRoot } = await fixture();
    input.args = ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'];
    const output: string[] = [];
    input.onLine = line => { output.push(line); };
    const pending = runner.run(input);
    await vi.waitFor(() => expect(output).toContain('ready'));
    await backend.pause('native:a');
    expect(await backend.inspect('native:a')).toMatchObject({ status: 'paused' });
    await backend.resume('native:a');
    expect(await backend.inspect('native:a')).toMatchObject({ status: 'running' });
    const recovered = new NativeAttemptExecutionBackend(stateRoot);
    expect(await recovered.inspect('native:a')).toMatchObject({ status: 'running' });
    runner.abort('a');
    await pending;
    expect(await recovered.listManaged()).toEqual([]);
  }, 15_000);
});
