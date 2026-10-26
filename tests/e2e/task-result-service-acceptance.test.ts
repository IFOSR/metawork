import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
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

function fixture(responder: FakeAttemptExecutionResponder, service = false, existing = false, independent = false) {
  const root = join(process.env.ANYFUSION_INSTALL_ROOT!, 'acceptance-user');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(process.env.ANYFUSION_INSTALL_ROOT!, 'app/current/dist'), { recursive: true });
  writeFileSync(join(process.env.ANYFUSION_INSTALL_ROOT!, 'app/current/dist/pi-attempt-tools.ts'), 'export default function () {}\n');
  if (existing) { mkdirSync(join(root, 'existing')); writeFileSync(join(root, 'existing', 'answer.md'), 'original'); }
  const db = new Database(':memory:'); runMigrations(db);
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
      if (!task || artifacts.publicFiles.list('local-default', taskId).length === 0) return null;
      // Delivery applies the authorized change set inside the target Workspace;
      // only an explicitly selected project keeps its own directory root.
      return task.publicProject && task.publicTaskDirectory
        ? join(root, task.publicTaskDirectory)
        : root;
    } });
  const session = new MetaclawSession({ taskEngine: engine, userArtifactPublication: delivery, managedLocalServices: services,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)), orchestration: new OrchestrationEngine(engine),
    sourceRoot: existing ? root : undefined, attemptExecutionBackend: backend, db, config, sessionId: 'session_acceptance', contextRecaller: new ContextRecaller(db),
    planningAgent: stubPlanningAgent(plan), getRuntimeBinding: async binding => ({ revisionId: binding.configurationRevision,
      bindingFingerprint: 'test-fingerprint', environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model' } }) });
  session.initialize({ resumeStartupTasks: false, showDashboard: false }); db.prepare('DELETE FROM work_units').run();
  cleanups.push(async () => { for (const record of new ManagedLocalServiceRepo(db, 'local-default').list()) await services.stop(record.specification.serviceId); db.close(); });
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

describe('user acceptance through the real Session / Kernel / publication loop', () => {
  it('keeps receipts on explicit retry and delivers the new attempt into the same directory', async () => {
    let calls = 0;
    const f = fixture(input => {
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'answer.md'), calls++ === 0 ? 'draft' : 'verified answer');
      return calls === 1 ? { rawOutput: 'Draft result without completion metadata.' }
        : { body: 'verified answer', artifacts: ['answer.md'] };
    });
    await f.session.submit('implement the answer', { awaitAsyncWork: true });
    const directory = f.task().publicTaskDirectory;
    const before = f.db.prepare('SELECT * FROM executor_attempt_receipts').all();
    expect(f.view().pendingActions.some(action => action.kind === 'accept_result'
      && action.result?.subtaskId === f.task().id ? false : action.kind === 'accept_result')).toBe(true);
    await f.session.submit(`/task retry-result ${f.task().id}`, { awaitAsyncWork: true });
    const after = f.db.prepare('SELECT * FROM executor_attempt_receipts').all();
    expect(after.length, JSON.stringify(f.session.getSnapshot().output)).toBeGreaterThan(before.length);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(f.task().publicTaskDirectory).toBe(directory);
    expect(f.task().status).toBe('succeeded');
    expect(readFileSync(join(f.root, 'answer.md'), 'utf8')).toBe('verified answer');
  });

  it('runs a real backend API smoke while the independent UI waits for user acceptance', async () => {
    const port = await freePort();
    let apiChecks = 0;
    const f = fixture(async input => {
      const node = f.db.prepare('SELECT goal FROM subtasks WHERE id = ?').get(input.subtaskId) as { goal: string };
      if (node.goal === 'independent UI implementation') return { rawOutput: 'UI draft needs acceptance.' };
      if (node.goal === 'independent backend API smoke') {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ready');
        apiChecks++;
        return { rawOutput: JSON.stringify({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: `real API check passed\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({ evidence: ['HTTP /health returned 200 and ready'], noChangeReason: null })}` }],
          stopReason: 'stop' } }) };
      }
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'server.mjs'), "import http from 'node:http';http.createServer((req,res)=>res.end('ready')).listen(process.env.PORT,process.env.HOST);");
      writeFileSync(join(workspace, '.metawork-service.json'), JSON.stringify({ serviceId: 'independent-api',
        command: process.execPath, args: ['server.mjs'], host: '127.0.0.1', port, healthPath: '/health',
        environmentReferences: {}, startupTimeoutMs: 1500, restartPolicy: 'explicit' }));
      return { body: 'implemented independent API', artifacts: ['server.mjs'] };
    }, true, false, true);
    await f.session.submit('implement backend and independent UI and start API', { awaitAsyncWork: true });
    expect(apiChecks, JSON.stringify({ output: f.session.getSnapshot().output, nodes: f.db.prepare('SELECT id, goal, status FROM subtasks').all(), calls: f.backend.create.mock.calls.map(([input]) => input.subtaskId) })).toBe(1);
    expect((await f.services.status('independent-api')).state).toBe('healthy');
    expect(f.view().pendingActions.some(action => action.kind === 'accept_result')).toBe(true);
    expect(f.view().status).toBe('needs_action');
    expect(f.task().status).not.toBe('succeeded');
    expect(f.db.prepare("SELECT status FROM subtasks WHERE goal = 'independent backend API smoke'").get(), JSON.stringify(f.db.prepare('SELECT error_code, error_detail FROM executor_attempt_receipts').all())).toEqual({ status: 'done' });
  }, 15000);

  it('accepts an uncertified result into the public directory without another Executor', async () => {
    const f = fixture(input => { writeFileSync(join(input.mounts.find(m => m.target === '/workspace')!.source, 'answer.md'), 'accepted answer');
      return { rawOutput: 'I created the requested answer but omitted completion metadata.' }; });
    await f.session.submit('implement the answer', { awaitAsyncWork: true });
    expect(f.view().pendingActions.some(action => action.kind === 'accept_result')).toBe(true);
    const calls = f.backend.create.mock.calls.length;
    await f.session.submit(`/task accept-result ${f.task().id}`, { awaitAsyncWork: true });
    expect(f.backend.create).toHaveBeenCalledTimes(calls);
    // eslint-disable-next-line no-console
    console.error('ACCEPT', f.task().status, f.task().stateDetail.reason.code, JSON.stringify(f.session.getSnapshot().output.slice(-8)));
    expect(f.task().status).toBe('succeeded');
    expect(readFileSync(join(f.root, 'answer.md'), 'utf8')).toBe('accepted answer');
    await f.session.submit(`/task accept-result ${f.task().id}`, { awaitAsyncWork: true });
    expect(f.backend.create).toHaveBeenCalledTimes(calls);
  });

  it('modifies the explicitly selected project at its original relative root', async () => {
    const f = fixture(input => {
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      expect(readFileSync(join(workspace, 'answer.md'), 'utf8')).toBe('original');
      writeFileSync(join(workspace, 'answer.md'), 'updated project'); return { body: 'updated', artifacts: ['answer.md'] };
    }, false, true);
    await f.session.submit('update the existing project', { awaitAsyncWork: true });
    expect(f.task().publicTaskDirectory).toBe('existing');
    expect(f.task().status).toBe('succeeded');
    expect(readFileSync(join(f.root, 'existing', 'answer.md'), 'utf8')).toBe('updated project');
  });

  it.each([true, false])('launches a real published service and gates completion on health=%s', async healthy => {
    const port = await freePort();
    const f = fixture(input => {
      const workspace = input.mounts.find(m => m.target === '/workspace')!.source;
      writeFileSync(join(workspace, 'server.mjs'), `import http from 'node:http';import fs from 'node:fs';
http.createServer((req,res)=>{res.statusCode=fs.existsSync('ready')?200:503;res.end(process.cwd());}).listen(process.env.PORT,process.env.HOST);`);
      if (healthy) writeFileSync(join(workspace, 'ready'), 'yes');
      writeFileSync(join(workspace, '.metawork-service.json'), JSON.stringify({ serviceId: 'acceptance-api',
        command: process.execPath, args: ['server.mjs'], host: '127.0.0.1', port, healthPath: '/health',
        environmentReferences: {}, startupTimeoutMs: 500, restartPolicy: 'explicit' }));
      return { body: 'implemented API', artifacts: ['server.mjs'] };
    }, true);
    await f.session.submit('implement and start API', { awaitAsyncWork: true });
    const status = await f.services.status('acceptance-api');
    // A startup timeout is a definite failure with the process stopped.
    expect(status.state).toBe(healthy ? 'healthy' : 'failed');
    if (healthy) {
      const response = await fetch(status.url + '/health');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(realpathSync(f.root));
    }
    // A required service that fails its health check is a definite business
    // failure; the delivered code is preserved and the Task does not revive.
    expect(f.view().status).toBe(healthy ? 'succeeded' : 'failed');
    expect(f.task().status === 'succeeded').toBe(healthy);
    if (!healthy) {
      expect(['service_health_timeout', 'service_start_failed']).toContain(f.task().stateDetail.reason.code);
      expect(f.view().status).toBe('failed');
    }
    expect(f.backend.create).toHaveBeenCalledTimes(1);
  }, 15000);
});
