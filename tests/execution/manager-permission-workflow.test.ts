import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionWorkflowService } from '../../src/execution/permission-workflow-service.js';
import type { AttemptExecutionBackend } from '../../src/execution/attempt-execution-backend.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import type { ManagerPermissionVerdict } from '../../src/resource/manager-permission-judge.js';
import type { CapabilityRequestInput, NormalizedCapabilityRequest } from '../../src/resource/types.js';

const cleanup: Database.Database[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of cleanup.splice(0)) db.close(); });
const now = '2026-11-08T00:00:00.000Z';
const input: CapabilityRequestInput = {
  capability: 'logical_resource_operation', resource: 'resource', operation: 'inspect',
  reason: 'Inspect the resource requested by the user', suggestedScope: 'attempt',
};
function fixture() {
  const db = new Database(':memory:');
  cleanup.push(db);
  initializeDatabaseSchema(db);
  db.pragma('foreign_keys = OFF');
  const repository = new SqlitePermissionRepository(db);
  const judge = vi.fn(async (_request: NormalizedCapabilityRequest, _options?: { signal?: AbortSignal }): Promise<ManagerPermissionVerdict> => ({
    verdict: 'grant', reason: 'covered by the user intent', grantedScope: 'once',
  }));
  const resume = vi.fn(async () => undefined);
  const checkpoint = vi.fn(async () => 'checkpoint');
  const onEscalation = vi.fn(async () => undefined);
  const deps = {
    context: { sessionId: 'conversation', taskId: 'task', generationId: 'generation', subtaskId: 'subtask',
      attemptId: 'attempt', agentClassName: 'pi', configurationRevision: 'config',
      permissionProfileId: 'standard-agent' as const, containerId: 'native-process', workspaceId: 'workspace', checkpointId: null },
    repository, manager: { judge }, deliverContinuation: async () => undefined, rules: [], clock: { now: () => now },
    resolver: { resolve: () => ({ kind: 'logical' as const, namespace: 'test', key: 'resource' }) },
    executionBackend: { pause: vi.fn(async () => undefined), inspect: vi.fn(async () => ({ status: 'paused' })), resume } as unknown as AttemptExecutionBackend,
    hooks: { checkpoint, onEscalation, onRecoveryAuthorized: vi.fn(async () => undefined) },
  };
  /** Rebuild the owner work event from durable permission facts. */
  const workEvent = (eventId: string, requestId: string) => {
    const record = repository.findRequest(requestId)!;
    return {
      schemaVersion: 5 as const,
      configurationRevision: 'config',
      type: 'permission_requested' as const,
      id: eventId,
      correlationId: requestId,
      causationId: null,
      occurredAt: record.createdAt,
      sessionId: 'conversation',
      taskId: 'task',
      subtaskId: 'subtask',
      attemptId: 'attempt',
      request: record.request,
    };
  };
  return { db, repository, judge, resume, checkpoint, onEscalation, deps, workEvent,
    service: new PermissionWorkflowService(deps) };
}

describe('Manager permission production workflow', () => {
  it('grants one exact call without user interaction and durably preserves the narrowed scope and reason', async () => {
    const f = fixture();
    const result = await f.service.request(input);
    expect(result.status).toBe('granted');
    const grant = f.repository.listGrants('attempt')[0]!;
    expect(grant).toMatchObject({ scope: 'once', limits: { maxCalls: 1 } });
    expect(f.repository.findRequest(result.requestId)?.decisionReason).toBe('covered by the user intent');
    expect(f.onEscalation).not.toHaveBeenCalled();
    expect(f.service.use({ grantId: grant.id, payload: 'operation' }).status).toBe('consumed');
    expect(f.service.use({ grantId: grant.id, payload: 'again' }).status).toBe('denied');
    expect(f.repository.listPermissionWork()).toEqual([]);
    expect((await f.service.request(input)).grantId).toBe(grant.id);
    expect(f.judge).toHaveBeenCalledTimes(1);
  });

  it.each([
    { capability: 'logical_resource_operation', operation: 'modify_permission_policy', status: 'denied' },
    { capability: 'external_object_operation', operation: 'send', status: 'escalated' },
    { capability: 'unknown_capability', operation: 'read', status: 'denied' },
  ])('enforces policy before Manager: $capability/$operation', async example => {
    const f = fixture();
    expect((await f.service.request({ ...input, ...example } as CapabilityRequestInput)).status).toBe(example.status);
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.repository.listGrants('attempt')).toEqual([]);
  });

  it('only one concurrent request owns pause/checkpoint/model work', async () => {
    const f = fixture();
    let release!: (value: ManagerPermissionVerdict) => void;
    f.judge.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = f.service.request(input);
    await vi.waitFor(() => expect(f.judge).toHaveBeenCalledOnce());
    expect((await f.service.request(input)).status).toBe('pending');
    expect(f.repository.listPermissionWork()).toEqual([]);
    release({ verdict: 'grant', reason: 'user requested it' });
    await first;
    expect(f.judge).toHaveBeenCalledOnce();
    expect(f.checkpoint).toHaveBeenCalledOnce();
    expect(f.repository.listGrants('attempt')).toHaveLength(1);
  });

  it('retains a recoverable request when checkpointing fails, and restart escalates without auto-approval', async () => {
    const f = fixture();
    f.checkpoint.mockRejectedValueOnce(new Error('checkpoint failed'));
    await expect(f.service.request(input)).rejects.toThrow('checkpoint failed');
    expect(f.judge).not.toHaveBeenCalled();
    const work = f.repository.listPermissionWork?.() ?? [];
    expect(work).toHaveLength(1);
    const restarted = new PermissionWorkflowService(f.deps);
    await restarted.recover(f.workEvent(work[0]!.eventId, work[0]!.requestId));
    expect(f.repository.findRequest(work[0]!.requestId)?.status).toBe('escalated');
    expect(f.repository.listGrants('attempt')).toEqual([]);
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.repository.listPermissionWork()).toEqual([]);
  });

  it('recovers an interrupted resume without judging or granting again', async () => {
    const f = fixture();
    f.resume.mockRejectedValueOnce(new Error('resume interrupted'));
    await expect(f.service.request(input)).rejects.toThrow('resume interrupted');
    const grant = f.repository.listGrants('attempt')[0]!;
    const work = f.repository.listPermissionWork?.() ?? [];
    expect(work).toHaveLength(1);
    await new PermissionWorkflowService(f.deps).recover(f.workEvent(work[0]!.eventId, work[0]!.requestId));
    expect(f.repository.listGrants('attempt')).toEqual([grant]);
    expect(f.judge).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledTimes(2);
    expect(f.repository.listPermissionWork()).toEqual([]);
  });

  it('a late Manager grant cannot overwrite a committed denial', async () => {
    const f = fixture();
    f.judge.mockImplementation(async request => {
      f.repository.deny({ request, decisionId: 'denial', deniedAt: now, reason: 'denied concurrently' });
      return { verdict: 'grant', reason: 'late answer' };
    });
    await expect(f.service.request(input)).rejects.toThrow('permission_decision_conflict');
    expect(f.repository.listGrants('attempt')).toEqual([]);
    expect(f.repository.listDeniedFingerprints('attempt')).toHaveLength(1);
  });

  it('timeout aborts the model and exposes exactly one user decision', async () => {
    const f = fixture();
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    f.judge.mockImplementation(async (_request, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });
    const result = f.service.request(input);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await result).status).toBe('escalated');
    expect(signal?.aborted).toBe(true);
    expect(f.onEscalation).toHaveBeenCalledOnce();
    expect(f.repository.listGrants('attempt')).toEqual([]);
  });

  it('cancellation during Manager judgment fences both granting and process resume', async () => {
    const f = fixture();
    let current = true;
    const service = new PermissionWorkflowService({ ...f.deps, isAttemptCurrent: () => current });
    f.judge.mockImplementation(async () => {
      current = false;
      return { verdict: 'grant', reason: 'late after cancellation' };
    });
    expect((await service.request(input)).status).toBe('denied');
    expect(f.repository.listGrants('attempt')).toEqual([]);
    expect(f.resume).not.toHaveBeenCalled();
    expect(service.use({ grantId: 'old-grant', payload: 'operation' }).status).toBe('denied');
  });
});
