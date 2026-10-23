import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { UserArtifactPublicationService } from '../../src/delivery/user-artifact-publication-service.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { ManagedLocalServiceRepo } from '../../src/storage/managed-local-service-repo.js';
import { ManagedLocalServices } from '../../src/execution/managed-local-service.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { KernelEffectOutboxRepo } from '../../src/storage/kernel-effect-outbox-repo.js';
import { SqliteTaskActivityFacts } from '../../src/storage/task-activity-facts-repo.js';
import { projectTaskView } from '../../src/task/task-view.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import type { Config } from '../../src/core/types.js';
import { singleSubtaskWorkGraph, stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend, type FakeAttemptExecutionResponder } from '../support/fake-attempt-execution-backend.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config: Config = { version: 1, executor: { command: 'codex', timeout: 60_000 },
  orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
    blocked_recheck_enabled: true, blocked_recheck_interval: 5, max_concurrent_attempts: 4 },
  ui: { language: 'zh-CN', dashboard_on_start: false } };

function fixture(responder: FakeAttemptExecutionResponder, service = false, existing = false, independent = false, databasePath = ':memory:') {
  const root = join(process.env.ANYFUSION_INSTALL_ROOT!, 'acceptance-user');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(process.env.ANYFUSION_INSTALL_ROOT!, 'app/current/dist'), { recursive: true });
  writeFileSync(join(process.env.ANYFUSION_INSTALL_ROOT!, 'app/current/dist/pi-attempt-tools.ts'), 'export default function () {}\n');
  if (existing) { mkdirSync(join(root, 'existing')); writeFileSync(join(root, 'existing', 'answer.md'), 'original'); }
  const db = new Database(databasePath); runMigrations(db);
  const repo = new TaskRepo(db); const engine = new TaskEngine(repo, '/tmp/metawork-acceptance');
  const artifacts = new TaskArtifactRepo(db);
  const delivery = new UserArtifactPublicationService({ userWorkspaceRoot: root, taskArtifactRepo: artifacts });
  const backend = new FakeAttemptExecutionBackend(responder);
  const plan = workGraphPlan({ goal: 'create working public result', deliveryKind: 'edit', fileOutputs: [] });
  if (independent) {
    plan.workGraph!.subtasks[0]!.id = 'backend';
    plan.workGraph!.subtasks[0]!.goal = 'backend implementation';
    const ui = singleSubtaskWorkGraph({ goal: 'independent UI implementation', deliveryKind: 'edit', fileOutputs: [] }).subtasks[0]!;
    ui.id = 'web-ui';
    const api = singleSubtaskWorkGraph({ goal: 'independent backend API smoke', executor: 'pi-agent', deliveryKind: 'report', fileOutputs: [] }).subtasks[0]!;
    api.id = 'api-smoke';
    api.dependencies = [{ fromSubtaskId: 'backend', requiredItems: [{ key: 'api', type: 'text', description: 'API implementation' }] }];
    plan.workGraph!.subtasks.push(ui, api);
  }
  if (service) plan.task = { ...plan.task!, startServiceAfterPublish: true };
  if (existing) plan.task = { ...plan.task!, publicProjectDirectory: 'existing' };
  const services = new ManagedLocalServices({ accountId: 'local-default', store: new ManagedLocalServiceRepo(db, 'local-default'),
    logRoot: join(root, '..', 'service-logs'), resolveEnvironment: async () => null,
    resolvePublishedDirectory: async taskId => {
      const task = repo.findById(taskId);
      return task?.publicTaskDirectory && artifacts.publicFiles.list('local-default', taskId).length > 0
        ? join(root, task.publicTaskDirectory) : null;
    } });
  const session = new MetaclawSession({ taskEngine: engine, userArtifactPublication: delivery, managedLocalServices: services,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)), orchestration: new OrchestrationEngine(engine),
    sourceRoot: existing ? root : undefined, attemptExecutionBackend: backend, db, config, sessionId: 'session_acceptance', contextRecaller: new ContextRecaller(db),
    planningAgent: stubPlanningAgent(plan), getRuntimeBinding: async binding => ({ revisionId: binding.configurationRevision,
      bindingFingerprint: 'test-fingerprint', environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model' } }) });
  session.initialize({ resumeStartupTasks: false, showDashboard: false });
  if (repo.findAll().length === 0) db.prepare('DELETE FROM work_units').run();
  cleanups.push(async () => { if (!db.open) return; for (const record of new ManagedLocalServiceRepo(db, 'local-default').list()) await services.stop(record.specification.serviceId); await session.dispose(); db.close(); });
  const task = () => repo.findAll()[0]!;
  const view = () => projectTaskView(new SqliteTaskActivityFacts(db).read(repo.findById(task().id)!, null));
  return { root, db, repo, session, backend, services, task, view };
}

async function freePort(): Promise<number> {
  return new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => {
    const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolve(port));
  }); });
}

describe('user result and service recovery journeys', () => {
  it.skipIf(!process.env.METAWORK_ACCEPTANCE_CRASH_ROOT)('SIGKILL acceptance checkpoint child', async () => {
    rmSync(process.env.ANYFUSION_INSTALL_ROOT!, { recursive: true, force: true });
    process.env.ANYFUSION_INSTALL_ROOT = process.env.METAWORK_ACCEPTANCE_CRASH_ROOT!;
    const f = fixture(() => { throw new Error('no new Executor at acceptance'); }, false, false, false,
      join(process.env.ANYFUSION_INSTALL_ROOT, 'acceptance.sqlite'));
    const internals = f.session as unknown as {
      attemptRunner: { stageAcceptedResult: (expected: unknown) => Promise<void> };
      kernelExecutionRuntime: { acceptPartialResult(id: string): Promise<unknown> };
    };
    internals.attemptRunner.stageAcceptedResult = async () => {
      process.kill(process.pid, 'SIGKILL');
      await new Promise<void>(() => undefined);
    };
    await internals.kernelExecutionRuntime.acceptPartialResult(f.task().id);
    throw new Error('checkpoint was not reached');
  });
  it('recovers a SIGKILL after acceptance commit from the disk database exactly once', async () => {
    const path = join(process.env.ANYFUSION_INSTALL_ROOT!, 'acceptance.sqlite');
    const f = fixture(input => {
      writeFileSync(join(input.mounts.find(m => m.target === '/workspace')!.source, 'answer.md'), 'durable answer');
      return { rawOutput: 'Safe draft without completion metadata.' };
    }, false, false, false, path);
    await f.session.submit('implement durable answer', { awaitAsyncWork: true });
    const id = f.task().id;
    const internals = f.session as unknown as { kernelExecutionRuntime: { dispose(): Promise<void> } };
    await internals.kernelExecutionRuntime.dispose();
    await f.session.dispose();
    f.db.close();

    await expect(promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'tests/e2e/task-state-recovery-journeys.test.ts', '--pool=threads', '--maxWorkers=1', '--minWorkers=1',
      '--testNamePattern=SIGKILL acceptance checkpoint child'], {
      cwd: process.cwd(), timeout: 30_000,
      env: { ...process.env, METAWORK_ACCEPTANCE_CRASH_ROOT: process.env.ANYFUSION_INSTALL_ROOT! },
    })).rejects.toMatchObject({ signal: 'SIGKILL' });

    const reopened = fixture(() => { throw new Error('recovery must not invoke an Executor'); }, false, false, false, path);
    expect(reopened.db.prepare("SELECT a.status FROM kernel_decision_applications a JOIN kernel_decisions d ON d.id = a.decision_id WHERE d.action = 'accept_uncertified_result'").get()).toEqual({ status: 'applied' });
    expect(reopened.db.prepare("SELECT count(*) AS n FROM task_state_changes WHERE operation_key LIKE 'accept_result:%'").get()).toEqual({ n: 1 });
    new KernelEffectOutboxRepo(reopened.db).reconcileSending(new Date().toISOString());
    const runtime = (reopened.session as unknown as { kernelExecutionRuntime: { recoverDue(id: string): Promise<unknown> } }).kernelExecutionRuntime;
    await runtime.recoverDue(id);
    await runtime.recoverDue(id);
    expect(reopened.repo.findById(id)?.status).toBe('succeeded');
    expect(reopened.db.prepare("SELECT count(*) AS n FROM workspace_publications WHERE id LIKE 'publication_accepted_%'").get()).toEqual({ n: 1 });
    expect(reopened.backend.create).not.toHaveBeenCalled();
    expect(readFileSync(join(reopened.root, reopened.repo.findById(id)!.publicTaskDirectory!, 'answer.md'), 'utf8')).toBe('durable answer');
    expect(reopened.view().state.status).toBe('succeeded');
  });
  it('recovers acceptance after state commit but before result staging', async () => {
    const f = fixture(input => { writeFileSync(join(input.mounts.find(m => m.target === '/workspace')!.source, 'answer.md'), 'draft');
      return { rawOutput: 'Safe draft without completion metadata.' }; });
    await f.session.submit('implement the answer', { awaitAsyncWork: true });
    const session = f.session as unknown as {
      attemptRunner: { stageAcceptedResult: (expected: unknown) => Promise<void> };
      kernelExecutionRuntime: { acceptPartialResult(id: string): Promise<unknown>; recoverDue(id: string, reason: string): Promise<unknown> };
    };
    const original = session.attemptRunner.stageAcceptedResult;
    session.attemptRunner.stageAcceptedResult = async () => { throw new Error('injected interruption before staging'); };
    await session.kernelExecutionRuntime.acceptPartialResult(f.task().id).catch(() => undefined);
    session.attemptRunner.stageAcceptedResult = original;
    await session.kernelExecutionRuntime.recoverDue(f.task().id, 'review interrupted acceptance');
    const publications = f.db.prepare("SELECT id FROM workspace_publications WHERE id LIKE 'publication_accepted_%'").all();
    expect(publications, JSON.stringify({task:f.task(), slots:f.db.prepare('SELECT * FROM conversation_task_slots').all(), effects:f.db.prepare('SELECT * FROM kernel_effect_outbox').all(), apps:f.db.prepare("SELECT * FROM kernel_decision_applications WHERE status <> 'applied'").all()})).toHaveLength(1);
  });
  it('waits for acceptance when service startup depends on an uncertified result', async () => {
    const f = fixture(input => { writeFileSync(join(input.mounts.find(m => m.target === '/workspace')!.source, 'answer.md'), 'draft');
      return { rawOutput: 'Safe draft without completion metadata.' }; }, true);
    await f.session.submit('implement and start the API', { awaitAsyncWork: true });
    expect(f.task().status).toBe('needs_action');
  });
  it('restarts a handed-over service without reviving its succeeded task', async () => {
    const port = await freePort();
    const f = fixture(input => {
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'server.mjs'), "import http from 'node:http';http.createServer((req,res)=>res.end('ready')).listen(process.env.PORT,process.env.HOST);");
      writeFileSync(join(workspace, '.metawork-service.json'), JSON.stringify({ serviceId: 'healthy-api', command: process.execPath,
        args: ['server.mjs'], host: '127.0.0.1', port, healthPath: '/health', environmentReferences: {}, startupTimeoutMs: 2000, restartPolicy: 'explicit' }));
      return { body: 'implemented API', artifacts: ['server.mjs'] };
    }, true);
    await f.session.submit('implement and start a healthy API', { awaitAsyncWork: true });
    const before = f.task();
    expect(before.status).toBe('succeeded');
    const pid = f.services.find('healthy-api')!.processId;
    await f.session.submit('/service restart healthy-api', { awaitAsyncWork: true });
    const restarted = f.services.find('healthy-api')!;
    expect(restarted.state).toBe('healthy');
    expect(restarted.processId).not.toBe(pid);
    expect(f.repo.findById(before.id)?.status).toBe('succeeded');
    expect(f.repo.findById(before.id)?.stateVersion).toBe(before.stateVersion);
    expect(f.backend.create).toHaveBeenCalledTimes(1);
  });
  it('reports port_in_use for an occupied required service port', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address() as { port: number };
    cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
    const f = fixture(input => {
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'server.mjs'), "import http from 'node:http';http.createServer((req,res)=>res.end('ready')).listen(process.env.PORT,process.env.HOST);");
      writeFileSync(join(workspace, '.metawork-service.json'), JSON.stringify({ serviceId: 'occupied-api', command: process.execPath,
        args: ['server.mjs'], host: '127.0.0.1', port: address.port, healthPath: '/health', environmentReferences: {}, startupTimeoutMs: 500, restartPolicy: 'explicit' }));
      return { body: 'implemented API', artifacts: ['server.mjs'] };
    }, true);
    await f.session.submit('implement and start API', { awaitAsyncWork: true });
    expect(f.task().status).toBe('failed');
    expect(f.task().stateDetail.reason.code).toBe('port_in_use');
    const original = f.task();
    const attempts = f.backend.create.mock.calls.length;
    const code = readFileSync(join(f.root, original.publicTaskDirectory!, 'server.mjs'), 'utf8');
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await f.session.submit(`/task retry ${original.id}`, { awaitAsyncWork: true });
    const retries = f.repo.findAll().filter(task => task.retryOfTaskId === original.id);
    expect(retries, JSON.stringify({output:f.session.getSnapshot().output, apps:f.db.prepare("SELECT a.status, a.error_summary, d.action, d.reason, d.task_id FROM kernel_decision_applications a JOIN kernel_decisions d ON d.id = a.decision_id WHERE a.status <> 'applied'").all()})).toHaveLength(1);
    expect(retries[0]!.status, JSON.stringify({detail:retries[0]!.stateDetail, effects:f.db.prepare("SELECT status, error_summary FROM kernel_effect_outbox WHERE effect_type='task_remaining_work'").all()})).toBe('succeeded');
    expect(f.repo.findById(original.id)?.status).toBe('failed');
    expect(f.repo.findById(original.id)?.stateDetail.reason.code).toBe('port_in_use');
    expect(f.backend.create.mock.calls.length).toBe(attempts);
    expect(readFileSync(join(f.root, original.publicTaskDirectory!, 'server.mjs'), 'utf8')).toBe(code);
    expect(f.db.prepare('SELECT count(*) AS n FROM subtasks WHERE task_id = ?').get(retries[0]!.id)).toEqual({ n: 0 });
    await f.session.submit(`/task retry ${original.id}`, { awaitAsyncWork: true });
    expect(f.repo.findAll().filter(task => task.retryOfTaskId === original.id)).toHaveLength(1);
    const deliveredPid = f.services.find('occupied-api')!.processId;
    await f.session.submit('/service restart occupied-api', { awaitAsyncWork: true });
    expect(f.services.find('occupied-api')!.state).toBe('healthy');
    expect(f.services.find('occupied-api')!.processId).not.toBe(deliveredPid);
    expect(f.repo.findById(original.id)?.status).toBe('failed');
  });
  it.each([false, true])('waits for a slot and respects cancellation before staging (cancel: %s)', async cancel => {
    const f = fixture(input => { writeFileSync(join(input.mounts.find(m => m.target === '/workspace')!.source, 'answer.md'), 'accepted answer');
      return { rawOutput: 'Safe draft without completion metadata.' }; });
    await f.session.submit('implement the answer', { awaitAsyncWork: true });
    const task = f.task();
    new TaskEngine(f.repo, '/tmp/review-other').create({ id: 'other_task', title: 'Other', goal: 'Other', conversationId: task.conversationId });
    f.db.prepare(`INSERT INTO conversation_task_slots (conversation_id,active_task_id,state,reservation_id,fairness_sequence,updated_at)
      VALUES (?, 'other_task', 'occupied', 'other_reservation', 1, 'now')
      ON CONFLICT(conversation_id) DO UPDATE SET active_task_id='other_task',state='occupied',reservation_id='other_reservation'`).run(task.conversationId);
    const runtime = (f.session as unknown as { kernelExecutionRuntime: {
      acceptPartialResult(id: string): Promise<unknown>; recoverDue(id: string): Promise<unknown>;
      cancelTask(id: string): Promise<unknown>;
    } }).kernelExecutionRuntime;
    await runtime.acceptPartialResult(task.id);
    const publications = f.db.prepare("SELECT id FROM workspace_publications WHERE id LIKE 'publication_accepted_%'").all();
    expect(publications).toHaveLength(0);
    expect(f.repo.findById(task.id)?.status).toBe('queued');
    expect(f.view().state.pendingActions.filter(action => action.kind === 'accept_result')).toHaveLength(0);
    if (cancel) await runtime.cancelTask(task.id);
    const scheduler = new ConversationTaskSchedulerRepo(f.db);
    scheduler.releaseSlot(task.conversationId!, 'other_task', new Date().toISOString());
    await runtime.recoverDue(task.id);
    await runtime.recoverDue(task.id);
    expect(f.db.prepare("SELECT count(*) AS n FROM workspace_publications WHERE id LIKE 'publication_accepted_%'").get()).toEqual({ n: cancel ? 0 : 1 });
    expect(f.repo.findById(task.id)?.status).toBe(cancel ? 'cancelled' : 'succeeded');
    expect(f.backend.create).toHaveBeenCalledTimes(1);
  });
});
