import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlannerDataReader } from '../../src/planning/planner-mcp-server.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { loadInputImages } from '../../src/executor/image-input-loader.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import type { Subtask } from '../../src/core/types.js';
import { testExecutorBinding } from '../support/seed-work-graph.js';

describe('Conversation historical artifact continuation', () => {
  it('bridges a prior image result from Planner selection to an attempt-local image input', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const root = mkdtempSync(join(tmpdir(), 'metawork-context-bridge-e2e-'));
    const publishedPath = join(root, 'published', 'product.jpg');
    const inputPath = join(root, 'attempt', 'inputs');
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
    mkdirSync(join(root, 'published'), { recursive: true });
    writeFileSync(publishedPath, imageBytes, { flag: 'w' });
    const contentHash = `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`;
    const taskEngine = new TaskEngine(new TaskRepo(db), join(root, 'snapshots'));
    const sourceTask = taskEngine.create({
      id: 'task-source-image',
      title: '生成商品图',
      goal: '生成并发布商品图',
      accountId: 'local-default',
      conversationId: 'conversation-image-continuation',
      workspaceId: 'workspace-image-continuation',
    });
    const targetTask = taskEngine.create({
      id: 'task-target-image',
      title: '修改商品图',
      goal: '把刚才的商品图改成夜景',
      accountId: 'local-default',
      conversationId: 'conversation-image-continuation',
      workspaceId: 'workspace-image-continuation',
    });
    try {
      db.prepare(`
        INSERT INTO task_artifacts (
          artifact_id, account_id, task_id, generation_id, subtask_id,
          publication_id, display_name, relative_path, published_path,
          media_type, preview_kind, content_hash, byte_length, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'artifact-source-product',
        'local-default',
        sourceTask.id,
        'generation-source',
        'subtask-source',
        'publication-source',
        'product.jpg',
        'assets/product.jpg',
        publishedPath,
        'image/jpeg',
        'image',
        contentHash,
        imageBytes.byteLength,
        'published',
        '2026-09-02T00:00:00.000Z',
        '2026-09-02T00:00:00.000Z',
      );

      const reader = new PlannerDataReader(
        db,
        'planner-session-image-continuation',
        () => ({ version: 2, configurationRevision: 'revision-test', capabilities: [], agentClasses: [] }),
        'conversation-image-continuation',
      );
      expect(reader.getCurrentSessionContext()?.artifacts).toEqual([
        expect.objectContaining({
          artifactId: 'artifact-source-product',
          availability: 'available',
        }),
      ]);

      const plan = PlanningAgentPlanSchema.parse({
        id: 'plan-image-continuation',
        schemaVersion: 8,
        action: 'plan_work_graph',
        confidence: 0.95,
        reason: '继续编辑会话中的商品图',
        clarificationQuestion: null,
        response: { directReply: null },
        task: {
          binding: 'new',
          taskId: null,
          control: 'none',
          scope: null,
          title: targetTask.title,
          goal: targetTask.goal,
          includeRecentConversationContext: true,
          priority: null,
        },
        risk: { level: 'low', requiresConfirmation: false, reasons: [] },
        authorizationResolution: null,
        workGraph: {
          schemaVersion: 7,
          configurationRevision: 'revision-test',
          reason: '继续编辑历史图片',
          subtasks: [{
            id: 'subtask-image-edit',
            title: '编辑历史商品图',
            goal: '将商品图改成夜景',
            dependencies: [],
            contextRefs: [{ kind: 'artifact', artifactId: 'artifact-source-product' }],
            requiredCapabilities: ['image-editing'],
            executorBindings: [{
              agentClassRef: 'pi-agent',
              modelSelection: { mode: 'agent-class-default' },
            }],
            deliveryKind: 'edit',
            acceptance: [{
              key: 'image_exists',
              description: '生成有效的编辑后图片',
              requiredEvidence: [],
            }],
            riskLevel: 'low',
          }],
        },
        source: 'anyfusion-planner',
      });
      const subtask = plan.workGraph!.subtasks[0] as Subtask;
      expect(buildEligibleContextRefKeys({
        db,
        sessionId: 'planner-session-image-continuation',
        conversationId: targetTask.conversationId,
        accountId: targetTask.accountId,
        workspaceId: targetTask.workspaceId,
        refs: subtask.contextRefs,
        targetTask,
        userInput: '把刚才的图改成夜景',
      })).toEqual(['artifact:artifact-source-product']);

      const built = new SubtaskExecutionContextBuilder(db, {
        accountId: 'local-default',
        resultRoot: join(root, 'results'),
      }).build({
        executionId: 'execution-image-continuation',
        task: targetTask,
        subtask: {
          ...subtask,
          taskId: targetTask.id,
          generationId: 'generation-target',
          executorBindings: [testExecutorBinding({
            agentClassRef: 'pi-agent',
            configurationRevision: 'revision-test',
          })],
        },
        allSubtasks: [],
        attemptId: 'attempt-image-continuation',
        workUnitId: 'work-unit-image',
        sessionId: 'planner-session-image-continuation',
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: root,
          targetPaths: [root],
        },
        inputFilesPath: inputPath,
        evidenceToolsAvailable: false,
      });
      const selected = built.context.selectedArtifacts?.[0];
      expect(selected?.relativeInputPath).toBe('input-01-product.jpg');
      expect(await loadInputImages(inputPath)).toEqual([
        expect.objectContaining({
          name: 'input-01-product.jpg',
          mimeType: 'image/jpeg',
          bytes: imageBytes,
        }),
      ]);
      expect(readFileSync(join(inputPath, selected!.relativeInputPath))).toEqual(imageBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
