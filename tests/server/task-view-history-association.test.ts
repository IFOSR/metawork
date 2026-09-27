import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import { resolveTaskViewTurnAssociation } from '../../src/gateway/task-view-association.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { runMigrations } from '../../src/storage/migrations.js';

const source = ts.createSourceFile('server-composition.ts',
  await readFile(new URL('../../src/server/server-composition.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let callback: ts.ArrowFunction | undefined;
function collect(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'getTaskView'
    && ts.isArrowFunction(node.initializer)) callback = node.initializer;
  ts.forEachChild(node, collect);
}
collect(source);

const input = {
  accountId: 'local-default', conversationId: 'conv_history', turnId: 'turn_old',
  taskId: 'task_old', requestId: 'req_view',
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function event(id: string, turnId: string, kind: GatewayEventEnvelope['kind'], payload: unknown): GatewayEventEnvelope {
  return {
    protocolVersion: 2, eventId: id, sequence: 0, ...input, turnId, kind, payload,
    occurredAt: `2026-09-26T00:00:0${id === 'trace_old' ? 1 : 0}.000Z`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'task-view-history-'));
  const db = new Database(':memory:');
  runMigrations(db);
  const runtime = createAccountEventJournal({ db, root, accountId: input.accountId, onError: error => { throw error; } });
  cleanups.push(async () => { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  const journal = runtime.journal;
  await journal.appendBatch([
    event('start_old', 'turn_old', 'turn_started', { userInput: 'Old task' }),
    event('trace_old', 'turn_old', 'trace_delta', {
      taskId: 'task_old', status: 'completed', events: [{ summary: 'Finished old task' }],
    }),
    event('start_new', 'turn_new', 'turn_started', { userInput: 'New turn' }),
  ]);
  expect((await journal.snapshot(input.accountId, input.conversationId)).snapshot.map(item => item.turnId))
    .toEqual(['turn_new']);
  const noReplay = vi.spyOn(journal, 'replay').mockRejectedValue(new Error('navigation must not replay'));
  const readTurn = vi.fn(async () => null);
  const task = { id: input.taskId, accountId: input.accountId, conversationId: input.conversationId, title: 'Old task' };
  class EmptyRepo { listByTask() { return []; } }
  const scope = {
    LOCAL_DEFAULT_ACCOUNT_ID: input.accountId, GATEWAY_TASK_VIEW_QUERY_VERSION: 1,
    webSessionCatalog: { readTurn }, eventJournal: journal, resolveTaskViewTurnAssociation,
    conversationRegistry: { getIfOpen: () => null },
    billingServices: { contexts: { findByTurnId: () => null } },
    taskRepo: { findById: vi.fn(() => task) },
    accountRegistry: { getIfLoaded: () => null },
    db, SubtaskRepo: EmptyRepo, KernelDispatchItemRepo: EmptyRepo,
    ExecutorAttemptReceiptRepo: EmptyRepo, GenerationReplanRequestRepo: EmptyRepo, WorkspacePublicationRepo: EmptyRepo,
    projectTaskViewFacts: async () => ({ result: null, routing: [], subtasks: [] }),
    projectTaskView: () => ({ lifecycle: 'terminal', phase: 'completed', timestamps: {} }),
    executionProjector: { project: () => ({ taskId: input.taskId, status: 'completed', stages: [] }) },
    accountRuntimeComposition: { runtimePort: { queries: {
      listRecoveryApplications: () => [], listCompletionResidue: () => [],
      listCurrentKernelDecisions: () => [], getQueuedTaskReason: () => null,
    } } },
    taskArtifactRepo: { listByTask: () => [] },
  };
  if (!callback) throw new Error('Production getTaskView callback missing');
  // Execute the source callback, not a test copy of association/watermark wiring.
  const { outputText } = ts.transpileModule(`const callback = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const getTaskView = new Function(...Object.keys(scope), `${outputText}\nreturn callback;`)(
    ...Object.values(scope),
  ) as (query: typeof input) => Promise<Record<string, unknown>>;
  return { journal, noReplay, readTurn, getTaskView, taskRepo: scope.taskRepo };
}

describe('production historical Task view lookup', () => {
  it('opens an older trace-only Task after a newer Turn without aggregate history or replay', async () => {
    const f = await fixture();
    const result = await f.getTaskView(input);
    expect(result).toMatchObject({
      taskId: 'task_old', turnId: 'turn_old', progressSummary: 'Finished old task',
      startedAt: '2026-09-26T00:00:01.000Z', completedAt: '2026-09-26T00:00:01.000Z',
      asOfSequence: 3,
    });
    expect(f.readTurn).toHaveBeenCalledWith(input.conversationId, input.turnId);
    expect(f.noReplay).not.toHaveBeenCalled();
  });

  it('fails closed on historical ambiguity, wrong Task, and an unknown Turn', async () => {
    const f = await fixture();
    expect(await f.getTaskView({ ...input, taskId: 'task_other' })).toEqual({ error: 'turn_task_mismatch' });
    expect(await f.getTaskView({ ...input, turnId: 'missing' })).toEqual({ error: 'turn_not_found' });
    await f.journal.append(event('trace_conflict', 'turn_old', 'trace_delta', { taskId: 'task_other' }));
    expect(await f.getTaskView(input)).toEqual({ error: 'turn_task_mismatch' });
    expect(f.taskRepo.findById).not.toHaveBeenCalled();
    expect(f.noReplay).not.toHaveBeenCalled();
  });
});
