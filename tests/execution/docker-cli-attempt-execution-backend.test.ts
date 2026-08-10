import {
  DockerCliAttemptExecutionBackend,
  type DockerCommandRunner,
} from '../../src/execution/docker-cli-attempt-execution-backend.js';
import { DEFAULT_ATTEMPT_EXECUTION_LIMITS } from '../../src/execution/attempt-execution-backend.js';

class FakeRunner implements DockerCommandRunner {
  calls: string[][] = [];

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (args[0] === 'image') return 'sha256:image';
    if (args[0] === 'network') return 'true';
    if (args[0] === 'create') return 'container-1';
    return '';
  }
}

describe('DockerCliAttemptExecutionBackend', () => {
  test('creates a constrained per-attempt container without Docker endpoints', async () => {
    const runner = new FakeRunner();
    const adapter = new DockerCliAttemptExecutionBackend(runner);
    await adapter.create({
      attemptId: 'attempt-1', taskId: 'task-1', generationId: 'generation-1', subtaskId: 'subtask-1',
      workUnitId: 'executor-1', leaseToken: 'lease-1', idempotencyKey: 'dispatch-1',
      imageRef: 'executor:phase5', resolvedImageId: 'sha256:image', command: 'codex', args: ['exec'],
      environment: {}, controlNetwork: 'metaclaw-control', egressMode: 'disabled', limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      mounts: [
        { source: '/managed/workspace', target: '/workspace', mode: 'rw' },
        { source: '/repo', target: '/source', mode: 'ro' },
        { source: '/inputs', target: '/inputs', mode: 'ro' },
      ],
    });
    const create = runner.calls.find(call => call[0] === 'create') ?? [];
    expect(create).toContain('--read-only');
    expect(create).toContain('--cap-drop=ALL');
    expect(create).toContain('--security-opt=no-new-privileges:true');
    expect(create.some(arg => arg.includes('docker.sock'))).toBe(false);
  });

  test('allows the nested user-namespace profile only for the canonical Codex image', async () => {
    const runner = new FakeRunner();
    const adapter = new DockerCliAttemptExecutionBackend(runner);
    const base = {
      attemptId: 'a', taskId: 't', generationId: 'g', subtaskId: 's', workUnitId: 'w', leaseToken: 'l', idempotencyKey: 'i',
      resolvedImageId: 'sha256:image', command: 'codex', args: ['exec'], environment: {}, controlNetwork: 'metaclaw-control',
      egressMode: 'disabled' as const, nestedSandbox: 'codex-workspace-write' as const,
      limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      mounts: [{ source: '/workspace', target: '/workspace', mode: 'rw' as const }],
    };
    await expect(adapter.create({ ...base, imageRef: 'custom:latest' })).rejects.toThrow('canonical pinned Codex image');
    await adapter.create({ ...base, imageRef: 'metaclaw-executor-codex:phase5' });
    const create = runner.calls.filter(call => call[0] === 'create').at(-1) ?? [];
    expect(create).toContain('--security-opt=seccomp=unconfined');
    expect(create).toContain('--security-opt=no-new-privileges:true');
  });

  test('fails closed on image drift and writable source mounts', async () => {
    const runner = new FakeRunner();
    const adapter = new DockerCliAttemptExecutionBackend(runner);
    const base = {
      attemptId: 'a', taskId: 't', generationId: 'g', subtaskId: 's', workUnitId: 'w', leaseToken: 'l', idempotencyKey: 'i',
      imageRef: 'executor:phase5', resolvedImageId: 'sha256:wrong', command: 'agent', args: [], environment: {},
      controlNetwork: 'metaclaw-control', egressMode: 'disabled' as const, limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      mounts: [{ source: '/workspace', target: '/workspace', mode: 'rw' as const }],
    };
    await expect(adapter.create(base)).rejects.toThrow('image drift');
    await expect(adapter.create({
      ...base,
      resolvedImageId: 'sha256:image',
      mounts: [...base.mounts, { source: '/repo', target: '/source', mode: 'rw' }],
    })).rejects.toThrow('/source must be read-only');
  });

  test('translates containerized control-plane paths to Engine-visible sibling mount sources', async () => {
    const runner = new FakeRunner();
    const adapter = new DockerCliAttemptExecutionBackend(runner, {
      sourcePathMappings: { '/control': 'D:\\metaclaw' },
    });
    await adapter.create({
      attemptId: 'a', taskId: 't', generationId: 'g', subtaskId: 's', workUnitId: 'w', leaseToken: 'l', idempotencyKey: 'i',
      imageRef: 'executor:phase5', resolvedImageId: 'sha256:image', command: 'agent', args: [], environment: {},
      controlNetwork: 'metaclaw-control', egressMode: 'disabled', limits: DEFAULT_ATTEMPT_EXECUTION_LIMITS,
      mounts: [{ source: '/control/workspaces/a', target: '/workspace', mode: 'rw' }],
    });
    const create = runner.calls.find(call => call[0] === 'create') ?? [];
    expect(create).toContain('type=bind,src=D:\\metaclaw\\workspaces\\a,dst=/workspace');
  });
});
