import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { PlanAdmissionResultRepo } from '../../src/storage/plan-admission-result-repo.js';
import { SqliteConversationDeletionStore } from '../../src/storage/conversation-deletion-repo.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function proposalRequest(overrides: { id: string; conversationId?: string; taskId?: string } = {
  id: 'plan_owner',
}) {
  const plan = workGraphPlan({ goal: 'admission result owner', capabilityClass: 'general' });
  plan.id = overrides.id;
  plan.workGraph!.subtasks[0]!.contextRefs = [];
  return {
    id: overrides.id,
    configurationRevision: 'revision-test',
    occurredAt: '2026-11-09T00:00:00.000Z',
    sessionId: 'planner-owner',
    conversationId: overrides.conversationId ?? 'conversation-owner',
    sourceTurnId: 'turn-owner',
    proposal: plan,
    requestText: 'admission result owner',
    generationId: 'generation-owner',
    proposalSource: 'initial' as const,
    targetGraphRevision: 1,
  };
}

function databaseAt(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  initializeDatabaseSchema(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-test', 'sha256:test', 'native', '2026-11-09T00:00:00.000Z')`).run();
  return db;
}

describe('plan admission result store', () => {
  it('records one applied outcome per proposal under the admission operation identity', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const results = new PlanAdmissionResultRepo(db);
    const saved = results.record({
      operationId: 'admission_plan_owner',
      proposalId: 'plan_owner',
      status: 'authorized',
      reason: 'work graph authorized',
      taskId: 'task_owner',
      generationId: 'generation-owner',
      graphRevision: 1,
      detail: { proposalSource: 'initial' },
      appliedAt: '2026-11-09T00:00:01.000Z',
    });
    expect(saved).toEqual({
      operationId: 'admission_plan_owner',
      proposalId: 'plan_owner',
      status: 'authorized',
      taskId: 'task_owner',
      generationId: 'generation-owner',
      graphRevision: 1,
      reason: 'work graph authorized',
      detail: { proposalSource: 'initial' },
      appliedAt: '2026-11-09T00:00:01.000Z',
    });
    expect(results.find('plan_owner')).toEqual(saved);
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_plan_admission_results').get())
      .toEqual({ count: 1 });
  });

  it('replays an identical outcome and refuses a different one for the same proposal', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const results = new PlanAdmissionResultRepo(db);
    const input = {
      operationId: 'admission_plan_owner',
      proposalId: 'plan_owner',
      status: 'queued' as const,
      reason: 'work graph authorized',
      taskId: 'task_owner',
      generationId: 'generation-owner',
      graphRevision: 1,
      detail: { schedulingReason: 'conversation_slot_occupied' },
      appliedAt: '2026-11-09T00:00:01.000Z',
    };
    const first = results.record(input);
    // The replay carries a later timestamp but the same identity, so it must
    // return the persisted fact instead of inserting or rewriting it.
    expect(results.record({ ...input, appliedAt: '2026-11-09T00:00:09.000Z' })).toEqual(first);
    expect(() => results.record({ ...input, status: 'rejected' })).toThrow(
      'plan admission result conflict: plan_owner',
    );
    expect(() => results.record({ ...input, taskId: 'task_other' })).toThrow(
      'plan admission result conflict: plan_owner',
    );
    expect(db.prepare('SELECT status, task_id FROM task_plan_admission_results').all())
      .toEqual([{ status: 'queued', task_id: 'task_owner' }]);
  });

  it('rejects invalid identities without writing a row', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const results = new PlanAdmissionResultRepo(db);
    expect(() => results.record({
      operationId: 'admission_plan_owner', proposalId: '', status: 'authorized', reason: 'x',
      appliedAt: '2026-11-09T00:00:00.000Z',
    })).toThrow('invalid plan admission result identity');
    expect(() => results.record({
      operationId: 'admission_plan_owner', proposalId: 'plan_owner', status: 'authorized', reason: '',
      appliedAt: '2026-11-09T00:00:00.000Z',
    })).toThrow('invalid plan admission result identity');
    expect(() => results.record({
      operationId: 'admission_plan_owner', proposalId: 'plan_owner', status: 'authorized', reason: 'x',
      appliedAt: 'not-a-date',
    })).toThrow('invalid plan admission result identity');
    expect(() => results.record({
      operationId: 'admission_plan_owner', proposalId: 'plan_owner', status: 'authorized', reason: 'x',
      graphRevision: 0, appliedAt: '2026-11-09T00:00:00.000Z',
    })).toThrow('invalid plan admission graph revision');
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_plan_admission_results').get())
      .toEqual({ count: 0 });
  });

  it('keeps a committed outcome visible to a second connection', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-admission-result-'));
    cleanup.push(root);
    const path = join(root, 'state.sqlite');
    const first = databaseAt(path);
    new PlanAdmissionResultRepo(first).record({
      operationId: 'admission_plan_owner',
      proposalId: 'plan_owner',
      status: 'clarification',
      reason: 'risk confirmation required',
      detail: { question: '继续吗？' },
      appliedAt: '2026-11-09T00:00:01.000Z',
    });
    const second = new Database(path);
    try {
      expect(new PlanAdmissionResultRepo(second).find('plan_owner')).toMatchObject({
        status: 'clarification',
        detail: { question: '继续吗？' },
      });
    } finally {
      second.close();
      first.close();
    }
  });

  it('erases applied outcomes with the Conversation that owned the proposal', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const proposals = new PlanProposalRepo(db);
    const results = new PlanAdmissionResultRepo(db);
    for (const [id, conversationId] of [['plan_keep', 'conversation-keep'], ['plan_drop', 'conversation-drop']] as const) {
      proposals.save({ request: proposalRequest({ id, conversationId }) });
      results.record({
        operationId: `admission_plan_proposal_${id}`,
        proposalId: id,
        status: 'rejected',
        reason: 'invalid PlanningAgentPlan',
        appliedAt: '2026-11-09T00:00:01.000Z',
      });
    }
    const deletions = new SqliteConversationDeletionStore(db);
    deletions.begin('account-owner', 'conversation-drop');
    deletions.cleanLocal('account-owner', 'conversation-drop');
    expect(results.find('plan_drop')).toBeNull();
    expect(results.find('plan_keep')).toMatchObject({ status: 'rejected' });
  });
});
