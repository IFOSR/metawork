import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { FileAttachmentStore } from '../../src/storage/file-attachment-store.js';
import { WebGatewaySessionRuntime } from '../../src/management/web-gateway-session-runtime.js';
import type {
  WebSessionRuntimeCatalog,
  WebSessionRuntimeEvent,
} from '../../src/management/web-session-runtime-types.js';
import type { WebSessionRecord } from '../../src/management/web-session-types.js';
import type { ExecutionTimeline } from '../../src/management/execution-projector.js';

describe('WebGatewaySessionRuntime', () => {
  it('selects the launch cwd as Workspace without creating a Conversation', async () => {
    const submitted: Array<{ connectionId: string; kind: string }> = [];
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => {
          submitted.push({ connectionId: envelope.connectionId, kind: envelope.command.kind });
          return {
            requestId: envelope.requestId,
            idempotencyKey: envelope.idempotencyKey,
            status: 'accepted' as const,
            workspaceId: 'workspace_repo',
            conversationId: null,
          };
        },
      }),
    });

    await runtime.initializeClient('browser-a', { workspaceHint: '/repo-a' });

    expect(runtime.getClientState('browser-a')).toEqual({
      activeWorkspaceId: 'workspace_repo',
      activeSessionId: null,
    });
    expect(submitted).toEqual([{ connectionId: 'web:browser-a', kind: 'select_workspace' }]);
  });

  it('direct attach restores the Conversation Workspace and ignores cwd', async () => {
    const gateway = gatewayFixture();
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    await runtime.initializeClient('browser-a', {
      workspaceHint: '/repo-other',
      conversationId: 'conv_1',
    });

    expect(runtime.getClientState('browser-a')).toEqual({
      activeWorkspaceId: 'workspace_repo',
      activeSessionId: 'conv_1',
    });
  });

  it('isolates active Workspace and Conversation between browser clients', async () => {
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway: gatewayFixture({
        submit: async envelope => ({
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          workspaceId: envelope.connectionId.endsWith('browser-a') ? 'workspace_a' : 'workspace_b',
          conversationId: null,
        }),
      }),
    });

    await runtime.initializeClient('browser-a', { workspaceHint: '/repo-a' });
    await runtime.initializeClient('browser-b', { workspaceHint: '/repo-b' });

    expect(runtime.getClientState('browser-a').activeWorkspaceId).toBe('workspace_a');
    expect(runtime.getClientState('browser-b').activeWorkspaceId).toBe('workspace_b');
  });

  it('projects replayed and live Workspace state without persisting a second authority', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    const record = sessionRecord('conv_1', true);
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: gatewayFixture({
        subscribe: (
          _accountId: string,
          _conversationId: string,
          next: (event: GatewayEventEnvelope) => void,
        ) => {
          listener = next;
          return () => undefined;
        },
        replay: async () => ({
          lastSequence: 1,
          snapshot: [workspaceSnapshot('conv_1', {
            path: '/repo-a',
            selectedAt: '2026-08-27T08:00:00.000Z',
          }, 1)],
          deltas: [],
        }),
      }),
    });
    const events: unknown[] = [];
    runtime.subscribe('browser-a', event => events.push(event));

    await attachBrowser(runtime);
    expect(runtime.getReplayEvents('browser-a')).toContainEqual({
      type: 'workspace_changed',
      sessionId: 'conv_1',
      workspace: {
        path: '/repo-a',
        selectedAt: '2026-08-27T08:00:00.000Z',
      },
    });
    await expect(runtime.listSessions('browser-a')).resolves.toMatchObject([{
      id: 'conv_1',
      workspace: {
        path: '/repo-a',
        selectedAt: '2026-08-27T08:00:00.000Z',
      },
    }]);

    listener!(workspaceChanged('conv_1', '/repo-b', 2));

    expect(events).toContainEqual({
      type: 'workspace_changed',
      sessionId: 'conv_1',
      workspace: {
        path: '/repo-b',
        selectedAt: '2026-08-27T09:00:00.000Z',
      },
    });
    await expect(runtime.readSession('browser-a', 'conv_1')).resolves.toMatchObject({
      session: {
        workspace: {
          path: '/repo-b',
          selectedAt: '2026-08-27T09:00:00.000Z',
        },
      },
    });
    expect(record.session).not.toHaveProperty('workspace');
  });

  it('subscribes before replay and merges buffered events without duplicates', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let resolveReplay!: (replay: GatewayReplay) => void;
    const replayPromise = new Promise<GatewayReplay>(resolve => {
      resolveReplay = resolve;
    });
    const calls: string[] = [];
    const gateway = {
      attachClient: async () => {
        calls.push('attach-client');
        return () => calls.push('detach-client');
      },
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        calls.push('subscribe');
        listener = next;
        return () => undefined;
      },
      replay: async () => {
        calls.push('replay');
        return replayPromise;
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    const initializing = attachBrowser(runtime);
    await waitFor(() => listener !== null);
    const buffered = outputEvent('event_2', 2, ['buffered']);
    listener!(buffered);
    resolveReplay({
      lastSequence: 2,
      snapshot: [],
      deltas: [
        outputEvent('event_1', 1, ['replayed']),
        buffered,
      ],
    });
    await initializing;

    expect(calls).toEqual(['attach-client', 'subscribe', 'replay']);
    expect(runtime.getReplayEvents('browser-a')).toEqual([
      { type: 'output', from: 0, lines: ['replayed'] },
      { type: 'output', from: 0, lines: ['buffered'] },
    ]);

    await runtime.dispose();
    expect(calls.at(-1)).toBe('detach-client');
  });

  it('invalidates and detaches an attach that completes during dispose', async () => {
    const attached = deferred<() => void>();
    const calls: string[] = [];
    const gateway = {
      attachClient: async () => {
        calls.push('attach-start');
        return attached.promise;
      },
      subscribe: () => {
        calls.push('subscribe');
        return () => calls.push('unsubscribe');
      },
      replay: async () => {
        calls.push('replay');
        return { lastSequence: 0, snapshot: [], deltas: [] };
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });

    const initializing = attachBrowser(runtime);
    await waitFor(() => calls.includes('attach-start'));
    const disposing = runtime.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    attached.resolve(() => calls.push('detach-client'));
    await expect(initializing).rejects.toThrow('disposed');
    await disposing;

    expect(calls).toEqual(['attach-start', 'detach-client']);
    expect(() => runtime.getClientState('browser-a')).toThrow('disposed');
  });

  it('enriches submitted user input with resolved attachment context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-runtime-attachments-'));
    try {
      const store = new FileAttachmentStore(join(root, 'attachments'));
      await store.initialize();
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const image = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'chart.png',
        bytes: pngMagic,
      });
      const doc = await store.saveAttachment({
        sessionId: 'conv_1',
        name: 'notes.md',
        bytes: Buffer.from('# 标题\n第一行内容', 'utf8'),
      });

      let capturedText = '';
      let capturedAttachments: Array<{ attachmentId: string; kind: string }> = [];
      const gateway = {
        attachClient: async () => () => undefined,
        subscribe: () => () => undefined,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
        submit: async (envelope: {
          requestId: string;
          command?: {
            text?: string;
            attachments?: Array<{ attachmentId: string; kind: string }>;
          };
        }) => {
          capturedText = envelope.command?.text ?? '';
          capturedAttachments = envelope.command?.attachments ?? [];
          return {
            requestId: envelope.requestId,
            idempotencyKey: 'idem_1',
            status: 'accepted' as const,
            conversationId: 'conv_1',
          };
        },
      } as unknown as WebGatewayAdapter;
      const runtime = new WebGatewaySessionRuntime({
        accountId: 'local-default',
        catalog: catalogFixture(),
        gateway,
        attachments: store,
        createId: prefix => `${prefix}_1`,
      });

      await attachBrowser(runtime);
      await runtime.submit('browser-a', '分析这些材料', [
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
      await runtime.dispose();

      expect(capturedText.startsWith('分析这些材料')).toBe(true);
      expect(capturedText).toContain('[附件] 2 个文件');
      expect(capturedText).toContain('chart.png (image/png');
      expect(capturedText).toContain('notes.md (text/markdown');
      expect(capturedText).toContain('第一行内容');
      expect(capturedAttachments).toEqual([
        { attachmentId: image.attachmentId, kind: 'file' },
        { attachmentId: doc.attachmentId, kind: 'file' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects live turn lifecycle events with the pending user input', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let submittedRequestId = '';
    const projected: unknown[] = [];
    const gateway = {
      attachClient: async () => () => undefined,
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        listener = next;
        return () => undefined;
      },
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      submit: async (envelope: { requestId: string }) => {
        submittedRequestId = envelope.requestId;
        return {
          requestId: envelope.requestId,
          idempotencyKey: 'idem_1',
          status: 'accepted' as const,
          conversationId: 'conv_1',
        };
      },
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
      createId: prefix => `${prefix}_1`,
    });
    runtime.subscribe('browser-a', event => projected.push(event));

    await attachBrowser(runtime);
    await runtime.submit('browser-a', '回答这个问题');
    listener!({
      ...outputEvent('event_started', 1, []),
      requestId: submittedRequestId,
      turnId: 'turn_1',
      kind: 'turn_started',
      payload: { commandKind: 'user_message' },
    });
    listener!({
      ...outputEvent('event_final', 2, []),
      requestId: submittedRequestId,
      turnId: 'turn_1',
      kind: 'final_answer',
      payload: { lines: ['这是最终答案'] },
    });

    expect(projected).toEqual([
      {
        type: 'turn_started',
        requestId: submittedRequestId,
        turnId: 'turn_1',
        userInput: '回答这个问题',
        startedAt: '2026-08-19T00:00:00.000Z',
      },
      {
        type: 'final_answer',
        requestId: submittedRequestId,
        turnId: 'turn_1',
        lines: ['这是最终答案'],
        completedAt: '2026-08-19T00:00:00.000Z',
      },
    ]);
  });

  it('persists the durable trace and execution timeline in the historical turn', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let appended: WebSessionRecord['turns'][number] | null = null;
    const record = catalogFixture();
    const timeline: ExecutionTimeline = {
      taskId: 'task_1',
      title: '执行任务',
      status: 'running',
      stages: [
        { phase: 'planning', status: 'done' },
        { phase: 'authorization', status: 'done' },
        {
          phase: 'execution',
          status: 'running',
          subtasks: [{
            id: 'sub_1',
            title: '生成 HTML',
            status: 'running',
            executor: 'codex-cli',
            attempts: [{
              attemptId: 'attempt_1',
              result: 'running',
              progressHistory: [{
                kind: 'status',
                text: '正在生成页面',
                occurredAt: '2026-08-19T00:00:02.000Z',
              }],
            }],
          }],
        },
        { phase: 'verification', status: 'pending' },
        { phase: 'delivery', status: 'pending' },
      ],
    };
    const gateway = {
      attachClient: async () => () => undefined,
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        listener = next;
        return () => undefined;
      },
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      submit: async (envelope: { requestId: string }) => ({
        requestId: envelope.requestId,
        idempotencyKey: 'idem_1',
        status: 'accepted' as const,
        conversationId: 'conv_1',
      }),
    } as unknown as WebGatewayAdapter;
    const catalog = {
      ...record,
      appendTurn: async (_sessionId: string, turn: WebSessionRecord['turns'][number]) => {
        appended = structuredClone(turn);
        return record;
      },
    } as unknown as WebSessionRuntimeCatalog;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog,
      gateway,
      projectExecutionTimeline: taskId => taskId === 'task_1' ? timeline : null,
      createId: prefix => `${prefix}_1`,
    });

    await attachBrowser(runtime);
    await runtime.submit('browser-a', '生成页面');
    listener!({
      ...outputEvent('event_started', 1, []),
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'turn_started',
      payload: { commandKind: 'user_message' },
    });
    listener!({
      ...outputEvent('event_trace', 2, []),
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_1',
        events: [{
          id: 'trace_executor',
          cursor: 'turn_1:1',
          eventKey: 'attempt_1:progress:1',
          sequence: 1,
          occurredAt: '2026-08-19T00:00:02.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: 'Executor progress',
          summary: '正在生成页面',
          taskId: 'task_1',
          subtaskId: 'sub_1',
          attemptId: 'attempt_1',
          details: { taskId: 'task_1', subtaskId: 'sub_1', attemptId: 'attempt_1' },
        }],
      },
    });
    listener!({
      ...outputEvent('event_final', 3, []),
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'final_answer',
      payload: { lines: ['页面已生成'] },
    });

    await waitFor(() => appended !== null);
    expect(appended).toMatchObject({
      id: 'turn_1',
      userInput: '生成页面',
      finalAnswer: '页面已生成',
      taskId: 'task_1',
      traceEvents: [expect.objectContaining({
        subtaskId: 'sub_1',
        attemptId: 'attempt_1',
        cursor: 'turn_1:1',
      })],
      executionTimeline: timeline,
    });
  });

  it('publishes the first-query session title after persisting a terminal turn', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    let record = sessionRecord('conv_1', true);
    const catalog: WebSessionRuntimeCatalog = {
      initialize: async () => undefined,
      create: async () => record,
      list: async () => [record.session],
      search: async () => [record.session],
      read: async () => record,
      workspaceIdForConversation: async () => 'workspace_repo',
      listWorkspaces: async () => [],
      appendTurn: async (_sessionId, turn) => {
        record = {
          ...record,
          session: {
            ...record.session,
            title: turn.userInput,
          },
          turns: [...record.turns, turn],
        };
        return record;
      },
      archive: async () => false,
      clearWorkspace: async () => 0,
    };
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog,
      gateway: gatewayFixture({
        subscribe: (
          _accountId: string,
          _conversationId: string,
          next: (event: GatewayEventEnvelope) => void,
        ) => {
          listener = next;
          return () => undefined;
        },
      }),
      createId: prefix => `${prefix}_1`,
    });
    const events: WebSessionRuntimeEvent[] = [];
    runtime.subscribe('browser-a', event => events.push(event));

    await attachBrowser(runtime);
    await runtime.submit('browser-a', '分析这个项目的模块边界');
    listener!({
      ...outputEvent('event_started', 1, []),
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'turn_started',
      payload: { commandKind: 'user_message' },
    });
    listener!({
      ...outputEvent('event_final', 2, []),
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'final_answer',
      payload: { lines: ['分析完成'] },
    });

    await waitFor(() => events.some(event => event.type === 'session_catalog'));
    expect(events).toContainEqual({
      type: 'session_catalog',
      activeSessionId: 'conv_1',
      sessions: [expect.objectContaining({
        id: 'conv_1',
        title: '分析这个项目的模块边界',
      })],
    });
  });

  it('rebuilds an explicit resume turn from durable task timeline and artifacts', async () => {
    const record: WebSessionRecord = {
      version: 1,
      session: {
        id: 'conv_1',
        title: 'Conversation',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:05:00.000Z',
        active: true,
        archived: false,
      },
      turns: [
        {
          id: 'turn_resume_old',
          sessionId: 'conv_1',
          userInput: '/task resume task_1',
          status: 'completed',
          finalAnswer: '恢复请求已提交',
          taskId: null,
          startedAt: '2026-08-19T00:00:00.000Z',
          completedAt: '2026-08-19T00:00:01.000Z',
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        },
        {
          id: 'turn_resume',
          sessionId: 'conv_1',
          userInput: '/task resume task_1',
          status: 'completed',
          finalAnswer: '恢复任务已完成',
          taskId: null,
          startedAt: '2026-08-19T00:01:00.000Z',
          completedAt: '2026-08-19T00:05:00.000Z',
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        },
      ],
    };
    const timeline: ExecutionTimeline = {
      taskId: 'task_1',
      title: '生成 HTML',
      status: 'done',
      stages: [
        { phase: 'planning', status: 'done' },
        { phase: 'authorization', status: 'done' },
        {
          phase: 'execution',
          status: 'done',
          subtasks: [{
            id: 'sub_1',
            title: '生成 HTML 报告',
            status: 'done',
            executor: 'codex-cli',
            attempts: [{
              attemptId: 'attempt_1',
              result: 'completed',
              progressHistory: [{
                kind: 'status',
                text: '报告已生成',
                occurredAt: '2026-08-19T00:04:00.000Z',
              }],
            }],
          }],
        },
        { phase: 'verification', status: 'done' },
        { phase: 'delivery', status: 'done' },
      ],
    };
    let timelineProjectionCount = 0;
    let artifactProjectionCount = 0;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogForRecord(record),
      gateway: {
        attachClient: async () => () => undefined,
        subscribe: () => () => undefined,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      } as unknown as WebGatewayAdapter,
      projectExecutionTimeline: taskId => {
        timelineProjectionCount += 1;
        return taskId === 'task_1' ? timeline : null;
      },
      projectTaskArtifacts: taskId => {
        artifactProjectionCount += 1;
        return taskId === 'task_1'
          ? [{
          artifactId: 'artifact_1',
          taskId: 'task_1',
          publicationId: 'publication_1',
          displayName: 'report.html',
          relativePath: 'reports/report.html',
          mediaType: 'text/html',
          previewKind: 'code',
          previewable: true,
          byteLength: 1_024,
          contentHash: 'sha256:abc',
          publishedAt: '2026-08-19T00:04:30.000Z',
          }]
          : [];
      },
    });

    await attachBrowser(runtime);
    const rebuilt = await runtime.readSession('browser-a', 'conv_1');

    expect(rebuilt?.turns[0]).toMatchObject({
      taskId: 'task_1',
      executionTimeline: null,
      artifacts: [],
    });
    expect(rebuilt?.turns[1]).toMatchObject({
      taskId: 'task_1',
      executionTimeline: timeline,
      artifactRefs: ['reports/report.html'],
      artifacts: [expect.objectContaining({
        artifactId: 'artifact_1',
        relativePath: 'reports/report.html',
      })],
    });
    expect(timelineProjectionCount).toBe(1);
    expect(artifactProjectionCount).toBe(1);
  });

  it('streams and reassembles result chunks before the terminal answer', async () => {
    let listener: ((event: GatewayEventEnvelope) => void) | null = null;
    const projected: unknown[] = [];
    const gateway = {
      attachClient: async () => () => undefined,
      subscribe: (
        _accountId: string,
        _conversationId: string,
        next: (event: GatewayEventEnvelope) => void,
      ) => {
        listener = next;
        return () => undefined;
      },
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    } as unknown as WebGatewayAdapter;
    const runtime = new WebGatewaySessionRuntime({
      accountId: 'local-default',
      catalog: catalogFixture(),
      gateway,
    });
    runtime.subscribe('browser-a', event => projected.push(event));
    await attachBrowser(runtime);

    const content = '第一段\n第二段';
    const bytes = Buffer.from(content, 'utf8');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const base = {
      ...outputEvent('event_result', 1, []),
      requestId: 'req_1',
      turnId: 'turn_1',
    };
    listener!({
      ...base,
      eventId: 'event_available',
      sequence: 1,
      kind: 'result_delivery_available',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: 'text/markdown',
        completeness: 'complete',
        certification: 'uncertified',
      },
    });
    listener!({
      ...base,
      eventId: 'event_chunk_1',
      sequence: 2,
      kind: 'result_chunk',
      payload: {
        resultId: 'result_1',
        offset: 0,
        chunk: '第一段\n',
        byteLength: Buffer.byteLength('第一段\n'),
      },
    });
    listener!({
      ...base,
      eventId: 'event_chunk_2',
      sequence: 3,
      kind: 'result_chunk',
      payload: {
        resultId: 'result_1',
        offset: Buffer.byteLength('第一段\n'),
        chunk: '第二段',
        byteLength: Buffer.byteLength('第二段'),
      },
    });
    listener!({
      ...base,
      eventId: 'event_completed',
      sequence: 4,
      kind: 'result_completed',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: 'text/markdown',
        completeness: 'complete',
        certification: 'uncertified',
      },
    });
    listener!({
      ...base,
      eventId: 'event_final',
      sequence: 5,
      kind: 'final_answer',
      payload: {
        resultId: 'result_1',
        contentHash,
        byteLength: bytes.byteLength,
        lines: [],
      },
    });

    expect(projected).toEqual([
      expect.objectContaining({
        type: 'result_delivery_available',
        resultId: 'result_1',
        certification: 'uncertified',
      }),
      expect.objectContaining({
        type: 'result_chunk',
        resultId: 'result_1',
        offset: 0,
        chunk: '第一段\n',
      }),
      expect.objectContaining({
        type: 'result_chunk',
        resultId: 'result_1',
        offset: Buffer.byteLength('第一段\n'),
        chunk: '第二段',
      }),
      expect.objectContaining({
        type: 'result_completed',
        resultId: 'result_1',
        content,
        certification: 'uncertified',
      }),
      expect.objectContaining({
        type: 'final_answer',
        lines: ['第一段', '第二段'],
      }),
    ]);
  });
});

function catalogFixture(): WebSessionRuntimeCatalog {
  const record = sessionRecord('conv_1', true);
  return catalogForRecord(record);
}

function sessionRecord(id: string, active: boolean): WebSessionRecord {
  return {
    version: 1,
    session: {
      id,
      title: 'Conversation',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      active,
      archived: false,
    },
    turns: [],
  };
}

function catalogForRecord(record: WebSessionRecord): WebSessionRuntimeCatalog {
  return {
    initialize: async () => undefined,
    create: async () => record,
    list: async () => [record.session],
    search: async () => [record.session],
    read: async () => record,
    workspaceIdForConversation: async () => 'workspace_repo',
    listWorkspaces: async () => [],
    archive: async () => true,
    clearWorkspace: async () => 0,
    appendTurn: async () => record,
  };
}

async function attachBrowser(
  runtime: WebGatewaySessionRuntime,
  clientId = 'browser-a',
): Promise<void> {
  await runtime.initializeClient(clientId, {
    workspaceHint: '/repo',
    conversationId: 'conv_1',
  });
}

function outputEvent(
  eventId: string,
  sequence: number,
  lines: string[],
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: null,
    turnId: null,
    kind: 'conversation_snapshot',
    payload: { from: 0, lines },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function workspaceSnapshot(
  conversationId: string,
  workspace: { path: string; selectedAt: string } | null,
  sequence: number,
): GatewayEventEnvelope {
  return {
    ...outputEvent(`workspace_snapshot_${sequence}`, sequence, []),
    conversationId,
    payload: { from: 0, lines: [], workspace },
  };
}

function workspaceChanged(
  conversationId: string,
  path: string,
  sequence: number,
): GatewayEventEnvelope {
  return {
    ...workspaceSnapshot(conversationId, null, sequence),
    eventId: `workspace_changed_${sequence}`,
    kind: 'workspace_changed',
    payload: {
      workspace: {
        path,
        selectedAt: '2026-08-27T09:00:00.000Z',
      },
    },
  };
}

function gatewayFixture(
  overrides: Partial<WebGatewayAdapter> = {},
): WebGatewayAdapter {
  return {
    attachClient: async () => () => undefined,
    subscribe: () => () => undefined,
    replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    restoreWorkspace: () => undefined,
    closeConnection: () => undefined,
    submit: async envelope => ({
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'accepted',
      conversationId: envelope.scope.kind === 'conversation'
        && envelope.scope.selection.mode === 'attach'
        ? envelope.scope.selection.conversationId
        : 'conv_new',
      workspaceId: 'workspace_repo',
    }),
    ...overrides,
  } as WebGatewayAdapter;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
