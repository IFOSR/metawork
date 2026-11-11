import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { event } from '../support/plan-admission-fixture.js';
import { proposedTaskId } from '../../src/execution/plan-proposal-store.js';

const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function open(path = ':memory:') {
  const db = new Database(path);
  databases.push(db);
  return { db, repo: new PlanProposalRepo(db) };
}
function input(id = 'proposal_1') {
  return {
    request: {
      ...structuredClone(event), proposal: { ...structuredClone(event.proposal), id: `plan_${id}` }, id, taskId: 'task_1', proposalSource: 'replan' as const,
      targetGraphRevision: 2, conversationId: 'conversation_1', sourceTurnId: 'turn_1',
      attachmentIds: ['attachment_1'],
    },
    replanRequestId: `job_${id}`, triggerOperationId: `trigger_${id}`,
  };
}

describe('Task Runtime proposal storage', () => {
  it('binds attachment origin only after Task creation, and never uses an unadmitted proposal', () => {
    const { repo } = open();
    const request = { ...input().request, proposalSource: 'initial' as const,
      taskId: undefined, targetGraphRevision: 1,
      proposal: { ...input().request.proposal, action: 'plan_work_graph' as const, task: { ...input().request.proposal.task, taskId: null } } };
    const taskId = proposedTaskId(request);
    repo.save({ request });
    expect(repo.findInitialForTask(taskId)).toBeNull();
    expect(() => repo.bindInitialToTask('other_task', request.id)).toThrow('invalid initial Task');
    repo.bindInitialToTask(taskId, request.id);
    repo.bindInitialToTask(taskId, request.id);
    expect(repo.findInitialForTask(taskId)?.request.attachmentIds).toEqual(['attachment_1']);
    const update = { ...request, id: 'update', proposal: { ...request.proposal, id: 'update_plan',
      task: { ...request.proposal.task, taskId } }, attachmentIds: ['injected_attachment'] };
    repo.save({ request: update });
    expect(() => repo.bindInitialToTask(taskId, update.id)).toThrow('invalid initial Task');
    expect(repo.findInitialForTask(taskId)?.request.id).toBe(request.id);
  });

  it('saves merge output with a trigger and no background Job, preserving replay identity', () => {
    const { repo } = open();
    const request = { ...input().request, proposalSource: 'conflict_replan' as const };
    const saved = repo.save({ request, triggerOperationId: 'merge_1' });
    expect(saved).toMatchObject({ replanRequestId: null, triggerOperationId: 'merge_1', delivery: 'pending' });
    expect(repo.save({ request, triggerOperationId: 'merge_1' })).toEqual(saved);
    expect(() => repo.save({ request, triggerOperationId: 'merge_2' })).toThrow('identity conflict');
    expect(repo.listPendingReplans(10)).toEqual([]);
  });

  it('rolls back proposal output if its transaction fails before commit', () => {
    const { db, repo } = open();
    expect(() => db.transaction(() => { repo.save(input()); throw new Error('crash'); })()).toThrow('crash');
    expect(repo.find(input().request.id)).toBeNull();
  });
  it('persists only owner input with exact attachments, Workspace and Turn, without Kernel tables', () => {
    const { db, repo } = open();
    const original = input();
    const result = repo.save({ ...original, request: { ...original.request,
      type: 'plan_proposed', schemaVersion: 5, correlationId: 'old', causationId: 'old',
    } as typeof original.request });
    expect(result).toMatchObject({ operationId: `admission_${original.request.proposal.id}`, delivery: 'pending', request: original.request });
    expect(result.request).not.toHaveProperty('type');
    expect(result.request).not.toHaveProperty('schemaVersion');
    expect(result.request).not.toHaveProperty('correlationId');
    expect(result.request).not.toHaveProperty('causationId');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([{ name: 'conversation_deletions' }, { name: 'conversation_turn_cancellations' },
        { name: 'task_plan_origins' }, { name: 'task_plan_proposals' }]);
    expect(db.prepare('PRAGMA foreign_key_list(task_plan_proposals)').all()).toEqual([]);
    original.request.attachmentIds.push('late');
    expect(repo.find(original.request.id)?.request.attachmentIds).toEqual(['attachment_1']);
  });

  it('replays equivalent object field ordering and refuses changed content under the same identity', () => {
    const { repo } = open();
    const original = input();
    const saved = repo.save(original);
    const reordered = Object.fromEntries(Object.entries(original.request).reverse()) as typeof original.request;
    expect(repo.save({ ...original, request: reordered })).toEqual(saved);
    expect(() => repo.save({ ...original, request: { ...original.request, requestText: 'different intent' } })).toThrow('identity conflict');
    expect(repo.find(original.request.id)).toEqual(saved);
  });

  it('prevents the same admission operation from being reused for a different proposal', () => {
    const { repo } = open();
    const first = input('first');
    const second = input('second');
    second.request.proposal.id = first.request.proposal.id;
    repo.save(first);
    expect(() => repo.save(second)).toThrow('identity conflict');
    expect(repo.find(second.request.id)).toBeNull();
  });

  it('refuses a second proposal identity for the same replan Job', () => {
    const { repo } = open();
    const original = input();
    repo.save(original);
    expect(() => repo.save({ ...original, request: { ...original.request, id: 'other' } })).toThrow('identity conflict');
    expect(repo.find('other')).toBeNull();
  });

  it.each([
    { sessionId: '' }, { configurationRevision: '' }, { generationId: '' },
    { targetGraphRevision: 0 }, { targetGraphRevision: 1.5 }, { occurredAt: 'invalid' },
  ])('refuses invalid identity %j before writing', override => {
    const { repo } = open();
    const original = input();
    expect(() => repo.save({ ...original, request: { ...original.request, ...override } })).toThrow('invalid plan proposal identity');
    expect(repo.listPendingReplans(10)).toEqual([]);
  });

  it('refuses partial or inconsistent replan origins', () => {
    const { repo } = open();
    const original = input();
    expect(() => repo.save({ request: original.request, replanRequestId: original.replanRequestId })).toThrow('invalid replan proposal origin');
    expect(() => repo.save({ ...original, request: { ...original.request, proposalSource: 'initial' } })).toThrow('invalid replan proposal origin');
    expect(() => repo.save({ ...original, request: { ...original.request, targetGraphRevision: 1 } })).toThrow('invalid replan proposal origin');
  });

  it('preserves pending output across a closed connection and a second repository instance', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-proposal-'));
    roots.push(root);
    const path = join(root, 'proposals.sqlite');
    const first = open(path);
    const saved = first.repo.save(input());
    first.db.close();
    const second = open(path);
    expect(second.repo.findForReplan(saved.replanRequestId!)).toEqual(saved);
    expect(second.repo.listPendingReplans(1)).toEqual([saved]);
    const third = open(path);
    expect(third.repo.save(input())).toEqual(saved);
    expect(second.repo.markForwarded(saved.request.id, event.occurredAt)).toBe(true);
    expect(third.repo.markForwarded(saved.request.id, event.occurredAt)).toBe(false);
    expect(third.repo.invalidate(saved.request.id, 'late', event.occurredAt)).toBe(false);
    expect(third.repo.listPendingReplans(1)).toEqual([]);
  });

  it('keeps an invalidated proposal immutable and cannot reopen it on resubmission', () => {
    const { repo } = open();
    const original = input();
    repo.save(original);
    expect(repo.invalidate(original.request.id, 'cancelled', event.occurredAt)).toBe(true);
    expect(repo.markForwarded(original.request.id, event.occurredAt)).toBe(false);
    expect(repo.save(original)).toMatchObject({ delivery: 'invalidated', deliveryReason: 'cancelled' });
    expect(repo.listPendingReplans(10)).toEqual([]);
  });

  it('rotates a failed delivery behind other pending Jobs and clears its notice on acknowledgement', () => {
    const { repo } = open();
    repo.save(input('a'));
    repo.save(input('b'));
    expect(repo.listPendingReplans(1)[0]?.request.id).toBe('a');
    repo.recordDeliveryFailure('a', '2026-11-09T00:00:00.000Z');
    expect(repo.listPendingReplans(1)[0]?.request.id).toBe('b');
    expect(repo.find('a')).toMatchObject({ delivery: 'pending', deliveryReason: 'admission_delivery_failed' });
    repo.markForwarded('a', '2026-11-09T00:00:01.000Z');
    expect(repo.find('a')?.deliveryReason).toBeNull();
    expect(() => repo.listPendingReplans(0)).toThrow('invalid proposal batch limit');
  });
});
