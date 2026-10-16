import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/types.js';
import { UserArtifactPublicationService, userTaskDirectorySlug } from '../../src/delivery/user-artifact-publication-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { singleSubtaskWorkGraph, stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { richDocumentFiles } from '../fixtures/rich-document-files.js';

// Real Session -> admission -> Kernel -> storage -> attempt -> Git publication ->
// user files. Only Planner/model and the side effect are deterministic fixtures.
describe('Planner-declared delivery end-to-end', () => {
  const cases = [
    { name: 'inline answer', goal: '请直接回答 2+2 等于几', outputs: [], files: [], kind: 'report', missing: false },
    { name: 'browser action receipt', goal: '打开浏览器进入百度', outputs: [], files: [], kind: 'report', missing: false },
    { name: 'unsolicited action reports', goal: '打开浏览器进入百度', outputs: [], files: ['browser_launch_report.md', 'browser_launch_result.txt'], kind: 'report', missing: false },
    { name: 'Git edit without report delivery', goal: '修改代码', outputs: [], files: ['code.ts'], kind: 'edit', missing: false },
    { name: 'requested report with scratch files', goal: '生成报告文件', outputs: ['report.md'], files: ['report.md', 'scratch.txt', 'build.py'], kind: 'report', missing: false },
    { name: 'requested Office and HTML files', goal: '交付办公文档和网页', outputs: ['result.docx', 'result.pptx', 'result.xlsx', 'index.html'], files: ['result.docx', 'result.pptx', 'result.xlsx', 'index.html', 'extra-report.md'], kind: 'report', missing: false },
    { name: 'dedicated directory', goal: '交付网站目录', outputs: ['site/'], files: ['site/index.html', 'site/style.css', 'site-copy/scratch.txt'], kind: 'edit', missing: false },
    { name: 'missing required file', goal: '生成报告文件', outputs: ['report.md'], files: ['scratch.txt'], kind: 'report', missing: true },
    { name: 'declared artifact handoff', goal: '生成文件后交给下游读取', outputs: ['source.txt'], files: ['source.txt', 'scratch.txt'], kind: 'report', missing: false },
    { name: 'missing file blocks downstream', goal: '生成文件后交给下游读取', outputs: ['source.txt'], files: ['scratch.txt'], kind: 'report', missing: true },
    { name: 'existing file delivery without rewrite', goal: '交付已有 README.md', outputs: ['README.md'], files: [], kind: 'report', missing: false },
  ] as const;

  it.each(cases)('$name', async testCase => {
    const files: readonly string[] = testCase.files;
    const outputs: readonly string[] = testCase.outputs;
    const handoff = ['declared artifact handoff', 'missing file blocks downstream'].includes(testCase.name);
    const fixtures = await richDocumentFiles();
    const contents: Record<string, Buffer> = { 'result.docx': fixtures['report.docx']!, 'result.pptx': fixtures['slides.pptx']!,
      'result.xlsx': fixtures['sales.xlsx']!, 'index.html': Buffer.from('<h1>交付网页</h1>') };
    const bytes = (file: string) => contents[file] ?? Buffer.from(`bytes:${file}`);
    const root = process.env.ANYFUSION_INSTALL_ROOT!;
    // Fake backend does not run Pi, but its production adapter still materializes the extension.
    mkdirSync(join(root, 'app/current/dist'), { recursive: true });
    writeFileSync(join(root, 'app/current/dist/pi-attempt-tools.ts'), 'export default function () {}\n');
    const userRoot = join(root, 'delivered');
    const db = new Database(join(root, 'delivery.sqlite'));
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, join(root, 'tasks'));
    let actualWorkspace = '';
    let actionCount = 0;
    const backend = new FakeAttemptExecutionBackend((input, attemptIndex) => {
      if (attemptIndex === 1 && handoff) {
        expect(input.args.join('\n')).toContain('source.txt');
        expect(input.args.join('\n')).not.toContain('scratch.txt');
        return { body: '已读取上游交付的文件。' };
      }
      actualWorkspace = input.mounts.find(mount => mount.target === '/workspace')!.source;
      expect(input.args.join('\n')).toContain(`Planner-declared fileOutputs: ${JSON.stringify(testCase.outputs)}`);
      actionCount++;
      for (const file of testCase.files) {
        mkdirSync(dirname(join(actualWorkspace, file)), { recursive: true });
        writeFileSync(join(actualWorkspace, file), bytes(file));
      }
      return { body: '操作已完成，结果已核对。', artifacts: [...testCase.files] };
    });
    const config: Config = {
      version: 1, executor: { command: 'codex', timeout: 60_000 },
      orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
        blocked_recheck_enabled: true, blocked_recheck_interval: 5, max_concurrent_attempts: 4 },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const plan = workGraphPlan({ goal: testCase.goal, deliveryKind: testCase.kind, fileOutputs: [...testCase.outputs] });
    if (handoff) {
      const consumer = singleSubtaskWorkGraph({ goal: '读取上游文件并返回文字摘要', executor: 'pi-agent', deliveryKind: 'report', fileOutputs: [] }).subtasks[0]!;
      consumer.id = 'consumer';
      consumer.dependencies = [{ fromSubtaskId: plan.workGraph!.subtasks[0]!.id,
        requiredItems: [{ key: 'source', type: 'artifact', description: '读取生成的文件' }] }];
      plan.workGraph!.subtasks.push(consumer);
    }
    const session = new MetaclawSession({
      taskEngine, db, config, sessionId: 'declared-delivery',
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine), contextRecaller: new ContextRecaller(db),
      userArtifactPublication: new UserArtifactPublicationService({ userWorkspaceRoot: userRoot, taskArtifactRepo: new TaskArtifactRepo(db) }),
      attemptExecutionBackend: backend,
      planningAgent: stubPlanningAgent(plan),
      getRuntimeBinding: async binding => ({ revisionId: binding.configurationRevision, bindingFingerprint: 'test-fingerprint',
        environment: { OPENAI_BASE_URL: 'https://test.invalid/v1', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-test', OPENAI_MODEL: 'test-model' } }),
    });
    try {
      session.initialize({ resumeStartupTasks: false, showDashboard: false });
      db.prepare('DELETE FROM work_units').run();
      await session.submit(testCase.goal, { awaitAsyncWork: true });
      await session.maybeReviewTaskPoolOnTimer();
      const [task] = taskRepo.findAll();
      expect(task).toBeDefined();
      const subtask = new SubtaskRepo(db).listByTask(task!.id).find(item => item.dependencies.length === 0);
      expect(subtask!.fileOutputs).toEqual(testCase.outputs);
      if (testCase.missing) {
        expect(subtask!.status).not.toBe('done');
        expect(db.prepare('SELECT terminal_state FROM executor_attempt_receipts').get()).toMatchObject({ terminal_state: 'uncertified_result' });
        expect(db.prepare('SELECT count(*) AS n FROM workspace_publications').get()).toEqual({ n: 0 });
        expect(subtask!.error).toContain('completion_file_output_missing');
        expect(db.prepare('SELECT count(*) AS n FROM subtask_handoffs').get()).toEqual({ n: 0 });
      } else expect(subtask!.status).toBe('done');
      const delivered = db.prepare('SELECT relative_path FROM task_artifacts ORDER BY relative_path').all() as Array<{ relative_path: string }>;
      const expectedFiles = testCase.name === 'existing file delivery without rewrite' ? ['README.md']
        : testCase.missing ? [] : files.filter(file => outputs.some(output => output.endsWith('/') ? file.startsWith(output) : file === output));
      expect(delivered.map(row => row.relative_path).sort()).toEqual([...expectedFiles].sort());
      const destination = join(userRoot, 'metaclaw-tasks', userTaskDirectorySlug(task!.title, task!.id));
      if (!expectedFiles.length) expect(existsSync(destination)).toBe(false);
      for (const file of expectedFiles) expect(readFileSync(join(destination, file))).toEqual(file === 'README.md'
        ? readFileSync(join(actualWorkspace, file)) : bytes(file));
      if (testCase.files.length === 0) expect(readdirSync(actualWorkspace).filter(file => !['.git', '.metaclaw'].includes(file))).toEqual(['README.md']);
      if (testCase.kind === 'edit') {
        // The edit remains present even though [] produces no downloadable artifacts.
        expect(readFileSync(join(actualWorkspace, testCase.files[0]!), 'utf8')).toBe(`bytes:${testCase.files[0]}`);
        expect(db.prepare("SELECT count(*) AS n FROM workspace_publications WHERE status='integrated'").get()).toEqual({ n: 1 });
      }
      await session.maybeReviewTaskPoolOnTimer();
      expect(backend.create, JSON.stringify(db.prepare('SELECT error_code, error_detail FROM executor_attempt_receipts').all())).toHaveBeenCalledTimes(handoff && !testCase.missing ? 2 : 1);
      expect(actionCount).toBe(1);
      // Verify the explicit declaration survives a database reopen, including [].
      const reopened = new Database(join(root, 'delivery.sqlite'));
      try { expect(new SubtaskRepo(reopened).findById(subtask!.id)?.fileOutputs).toEqual(testCase.outputs); }
      finally { reopened.close(); }
    } finally { db.close(); }
  }, 30_000);
});
