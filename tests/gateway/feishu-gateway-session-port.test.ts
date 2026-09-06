import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import type { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import type { FeishuGatewayDelivery } from '../../src/integrations/feishu-app.js';
import { FeishuGatewaySessionPort } from '../../src/gateway/feishu-gateway-session-port.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { clientConnectionEventStreamId } from '../../src/gateway/client-connection-event-stream.js';

describe('FeishuGatewaySessionPort', () => {
  it('confirms a restored Workspace once across repeated Conversation replay', async () => {
    let currentRequestId = 'req_1';
    const workspace = workspaceSnapshot('/repo-a', 1);
    const progressMessages: string[] = [];
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async (
          _sender: unknown,
          _channel: unknown,
          _text: string,
          requestId: string,
        ) => {
          currentRequestId = requestId;
          return {
            requestId,
            idempotencyKey: `feishu:${requestId}`,
            status: 'accepted',
            conversationId: 'conv_1',
          };
        },
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async () => ({
          lastSequence: 3,
          snapshot: [workspace],
          deltas: [
            {
              ...workspace,
              eventId: 'event_output_snapshot',
              sequence: 2,
              payload: { from: 0, lines: ['progress without Workspace projection'] },
            },
            finalEventFor(currentRequestId, 3),
          ],
        }),
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'first',
      requestId: 'req_1',
      onProgress: message => progressMessages.push(message),
    })).resolves.toEqual(['final answer']);
    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'second',
      requestId: 'req_2',
      onProgress: message => progressMessages.push(message),
    })).resolves.toEqual(['final answer']);

    expect(progressMessages).toEqual(['当前 Workspace：/repo-a']);
  });

  it('confirms only the newest canonical Workspace when replay contains a change', async () => {
    const progressMessages: string[] = [];
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_workspace',
          idempotencyKey: 'feishu:req_workspace',
          status: 'accepted',
          conversationId: 'conv_1',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async () => ({
          lastSequence: 3,
          snapshot: [workspaceSnapshot('/repo-old', 1)],
          deltas: [
            workspaceChanged('/repo-new', 2, 'req_workspace'),
            finalEventFor('req_workspace', 3),
          ],
        }),
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '/workspace /repo-new',
      requestId: 'req_workspace',
      onProgress: message => progressMessages.push(message),
    })).resolves.toEqual(['final answer']);

    expect(progressMessages).toEqual(['当前 Workspace：/repo-new']);
  });

  it('returns workspace_required as an executable Feishu prompt', async () => {
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_1',
          idempotencyKey: 'feishu:req_1',
          status: 'rejected',
          reason: 'workspace_required',
          conversationId: 'conv_1',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'run task',
      requestId: 'req_1',
      onProgress: () => undefined,
    })).resolves.toEqual([
      expect.stringContaining('/workspace /absolute/path'),
    ]);
  });

  it('consumes a terminal snapshot exactly once when replay overlaps deltas', async () => {
    const terminal = finalEvent();
    const progress = progressEvent();
    const replay: GatewayReplay = {
      lastSequence: terminal.sequence,
      snapshot: [terminal],
      deltas: [progress, progress],
    };
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => {
        subscriptions.publish(progress);
        return replay;
      },
    };
    const adapter = {
      handleMessage: async () => ({
        requestId: 'req_1',
        idempotencyKey: 'feishu:req_1',
        status: 'accepted',
        conversationId: 'conv_1',
      }),
    } as unknown as FeishuGatewayAdapter;
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter,
      journal,
      subscriptions,
      timeoutMs: 100,
    });
    const progressMessages: string[] = [];

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'hello',
      requestId: 'req_1',
      onProgress: message => progressMessages.push(message),
    })).resolves.toEqual(['final answer']);
    expect(progressMessages).toHaveLength(2); // activity card + completion receipt
    expect(progressMessages[0]).toContain('Planning：Inspecting context');
    expect(progressMessages[1]).toContain('任务已完成');
  });

  it('reassembles a large replayed result instead of relying on final-answer lines', async () => {
    const answer = `开头\n${'长结果'.repeat(30_000)}\n结尾`;
    const first = answer.slice(0, 50_001);
    const second = answer.slice(50_001);
    const contentHash = `sha256:${createHash('sha256')
      .update(Buffer.from(answer))
      .digest('hex')}`;
    const resultEvents = [
      resultEvent(1, 'result_delivery_available', {
        resultId: 'result_large',
        contentHash,
        byteLength: Buffer.byteLength(answer),
        completeness: 'complete',
        certification: 'certified',
      }),
      resultEvent(2, 'result_chunk', {
        resultId: 'result_large',
        offset: 0,
        chunk: first,
        byteLength: Buffer.byteLength(first),
      }),
      resultEvent(3, 'result_chunk', {
        resultId: 'result_large',
        offset: Buffer.byteLength(first),
        chunk: second,
        byteLength: Buffer.byteLength(second),
      }),
      resultEvent(4, 'result_completed', {
        resultId: 'result_large',
        contentHash,
        byteLength: Buffer.byteLength(answer),
        completeness: 'complete',
        certification: 'certified',
      }),
      resultEvent(5, 'final_answer', {
        resultId: 'result_large',
        lines: [],
      }),
    ];
    const subscriptions = new GatewaySubscriptions();
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_1',
          idempotencyKey: 'feishu:req_1',
          status: 'accepted',
          conversationId: 'conv_1',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async () => ({
          lastSequence: 5,
          snapshot: [resultEvents[3]!, resultEvents[4]!],
          deltas: resultEvents.slice(0, 4),
        }),
      },
      subscriptions,
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'large answer',
      requestId: 'req_1',
      onProgress: () => undefined,
    })).resolves.toEqual(answer.split('\n'));
  });

  it('renders the selected Workspace directory without replaying Conversation details', async () => {
    const replayedStreams: string[] = [];
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_list',
          idempotencyKey: 'feishu:req_list',
          status: 'accepted',
          conversationId: null,
          workspaceId: 'workspace_repo',
          routeKind: 'workspace_directory',
          connectionId: 'feishu_chat',
          projectionRequestId: 'req_list',
          projectionStreamId: clientConnectionEventStreamId('feishu_chat'),
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async (_accountId, streamId) => {
          replayedStreams.push(streamId);
          return {
            lastSequence: 1,
            snapshot: [],
            deltas: [
              workspaceDirectoryEvent({
                nextCursor: 'cursor_old',
                items: [
                  conversationSummary('conv_old', 'Old page', 'idle', null),
                ],
              }),
              workspaceDirectoryPageEvent({
                nextCursor: 'cursor_next',
                items: [
                  conversationSummary('conv_running', 'Fix release', 'executing', 'task_1'),
                  conversationSummary('conv_idle', 'Review docs', 'idle', null),
                ],
              }, 'req_list', clientConnectionEventStreamId('feishu_chat')),
              workspaceActivityEvent('conv_running', 'executing', 'task_1'),
            ],
          };
        },
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      threadId: 'thread_1',
      text: '/conversations',
      requestId: 'req_list',
      onProgress: () => undefined,
    })).resolves.toEqual({
      lines: [
        '# Workspace: MetaWork',
        '路径：/repo',
        '1. Fix release [executing] · Task task_1 · conv_running',
        '2. Review docs [idle] · conv_idle',
      ],
      actions: [{
        label: '下一页',
        value: {
          kind: 'workspace_conversations',
          cursor: 'cursor_next',
          threadId: 'thread_1',
        },
      }],
    });
    expect(replayedStreams).toEqual([clientConnectionEventStreamId('feishu_chat')]);
  });

  it('renders an attach summary with activity, current Task and only the latest three turns', async () => {
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_attach',
          idempotencyKey: 'feishu:req_attach',
          status: 'accepted',
          conversationId: 'conv_1',
          workspaceId: 'workspace_repo',
          routeKind: 'conversation_attached',
          connectionId: 'feishu_chat',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async (_accountId, streamId) => {
          if (streamId === 'workspace_directory_workspace_repo') {
            return {
              lastSequence: 1,
              snapshot: [],
              deltas: [workspaceDirectoryEvent({
                nextCursor: null,
                items: [conversationSummary('conv_1', 'Implement routing', 'planning', 'task_9')],
              })],
            };
          }
          return {
            lastSequence: 2,
            snapshot: [],
            deltas: [historyPageEvent([
              turn('turn_4', 'four', 'answer four'),
              turn('turn_3', 'three', 'answer three'),
              turn('turn_2', 'two', 'answer two'),
            ], null, 'cursor_older')],
          };
        },
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    const response = await port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '/conversation conv_1',
      requestId: 'req_attach',
      onProgress: () => undefined,
    });

    expect(response).toMatchObject({
      lines: [
        '# Implement routing',
        '状态：planning',
        '当前 Task：task_9',
        '最近对话：',
        '用户：four',
        'MetaWork：answer four',
        '用户：three',
        'MetaWork：answer three',
        '用户：two',
        'MetaWork：answer two',
      ],
    });
    expect(JSON.stringify(response)).not.toContain('turn_1');
  });

  it('renders bounded history and forwards Server cursors as card actions', async () => {
    const replayedStreams: string[] = [];
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_history',
          idempotencyKey: 'feishu:req_history',
          status: 'accepted',
          conversationId: 'conv_1',
          workspaceId: 'workspace_repo',
          routeKind: 'conversation_history',
          connectionId: 'feishu_chat',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async (_accountId, streamId) => {
          replayedStreams.push(streamId);
          return {
            lastSequence: 1,
            snapshot: [],
            deltas: [
              historyPageEvent(
                [turn('turn_2', 'question', 'answer')],
                'cursor_newer',
                'cursor_older',
                'req_history',
                1,
              ),
              historyPageEvent(
                [turn('turn_other', 'other request', 'wrong page')],
                null,
                null,
                'req_other',
                2,
              ),
            ],
          };
        },
      },
      subscriptions: new GatewaySubscriptions(),
      timeoutMs: 100,
    });

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '/history 10',
      requestId: 'req_history',
      onProgress: () => undefined,
    })).resolves.toEqual({
      lines: [
        '# Conversation History',
        '用户：question',
        'MetaWork：answer',
      ],
      actions: [
        {
          label: '上一页',
          value: {
            kind: 'conversation_history',
            cursor: 'cursor_newer',
            limit: 10,
          },
        },
        {
          label: '下一页',
          value: {
            kind: 'conversation_history',
            cursor: 'cursor_older',
            limit: 10,
          },
        },
      ],
    });
    expect(replayedStreams).toEqual(['conv_1']);
  });

  it('keeps an attached Conversation subscribed for external live progress and results', async () => {
    const subscriptions = new GatewaySubscriptions();
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_attach',
          idempotencyKey: 'feishu:req_attach',
          status: 'accepted',
          conversationId: 'conv_1',
          workspaceId: 'workspace_repo',
          routeKind: 'conversation_attached',
          connectionId: 'feishu_chat',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async (_accountId, streamId) => (
          streamId === 'workspace_directory_workspace_repo'
            ? {
                lastSequence: 1,
                snapshot: [],
                deltas: [workspaceDirectoryEvent({
                  nextCursor: null,
                  items: [conversationSummary('conv_1', 'Live task', 'idle', null)],
                })],
              }
            : {
                lastSequence: 1,
                snapshot: [],
                deltas: [historyPageEvent([], null, null, 'attach_history')],
              }
        ),
      },
      subscriptions,
      timeoutMs: 100,
    });
    const deliveries: unknown[] = [];
    const unsubscribe = port.subscribeGatewayDelivery(delivery => {
      deliveries.push(delivery);
    });

    await port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      threadId: 'thread_1',
      text: '/conversation conv_1',
      requestId: 'req_attach',
      onProgress: () => undefined,
    });
    subscriptions.publish({
      ...progressEvent(),
      eventId: 'event_web_progress',
      requestId: 'req_web',
      conversationId: 'conv_1',
    }, { connectionId: 'web_client', surface: 'web' });
    subscriptions.publish({
      ...finalEventFor('req_web', 3),
      eventId: 'event_web_final',
      conversationId: 'conv_1',
      payload: { lines: ['web answer'] },
    }, { connectionId: 'web_client', surface: 'web' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deliveries).toEqual([]);

    subscriptions.publish({
      ...progressEvent(),
      eventId: 'event_feishu_progress',
      requestId: 'req_feishu',
      conversationId: 'conv_1',
    }, { connectionId: 'feishu_chat', surface: 'feishu' });
    subscriptions.publish({
      ...finalEventFor('req_feishu', 4),
      eventId: 'event_feishu_final',
      conversationId: 'conv_1',
      payload: { lines: ['feishu answer'] },
    }, { connectionId: 'feishu_chat', surface: 'feishu' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(deliveries).toEqual([
      {
        senderId: 'user_1',
        chatId: 'chat_1',
        threadId: 'thread_1',
        kind: 'progress',
        reply: {
          lines: [expect.stringContaining('Planning：Inspecting context')],
          cardUpdateKey: 'feishu-activity:live:conv_1:turn_1',
        },
      },
      {
        senderId: 'user_1',
        chatId: 'chat_1',
        threadId: 'thread_1',
        kind: 'final',
        reply: { lines: ['feishu answer'] },
      },
    ]);
    unsubscribe();
  });

  it('converges executor progress floods into a throttled activity card and pushes milestones immediately', async () => {
    const subscriptions = new GatewaySubscriptions();
    const traceFlood = (sequence: number): GatewayEventEnvelope => ({
      ...finalEvent(),
      eventId: `event_trace_${sequence}`,
      sequence,
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_1',
        events: [{
          id: `evt_${sequence}`,
          sequence,
          occurredAt: '2026-09-05T01:00:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: 'Executor progress: skill',
          summary: `Executor started tool: web_search — query ${sequence}`,
          details: {},
          taskId: 'task_1',
        }],
      },
    });
    const milestoneEvent: GatewayEventEnvelope = {
      ...finalEvent(),
      eventId: 'event_milestone',
      sequence: 90,
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_1',
        events: [{
          id: 'evt_milestone',
          sequence: 90,
          occurredAt: '2026-09-05T01:00:01.000Z',
          phase: 'execution',
          actor: 'runtime',
          kind: 'subtask_execution_started',
          status: 'running',
          title: 'Executing Subtask: 收集视频号数据',
          summary: '',
          details: {},
          taskId: 'task_1',
          subtaskId: 'sub_1',
        }, {
          id: 'evt_milestone_chat',
          sequence: 91,
          occurredAt: '2026-09-05T01:00:02.000Z',
          phase: 'execution',
          actor: 'runtime',
          kind: 'executor_result_observed',
          status: 'completed',
          title: 'Result observed',
          summary: '子任务完成',
          details: {},
          taskId: 'task_1',
          subtaskId: 'sub_1',
        }],
      },
    };
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => {
        const origin = { connectionId: 'feishu:chat_1:', surface: 'feishu' as const };
        subscriptions.publish(milestoneEvent, origin);
        subscriptions.publish(traceFlood(1), origin);
        subscriptions.publish(traceFlood(2), origin);
        subscriptions.publish(traceFlood(3), origin);
        return { lastSequence: 99, snapshot: [], deltas: [finalEventFor('req_1', 99)] };
      },
    };
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_1',
          idempotencyKey: 'feishu:req_1',
          status: 'accepted',
          conversationId: 'conv_1',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal,
      subscriptions,
      timeoutMs: 500,
      activityCardMinIntervalMs: 60_000,
    });
    const progressCalls: Array<{ text: string; cardUpdateKey?: string }> = [];

    await expect(port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'research',
      requestId: 'req_1',
      onProgress: (text, options) => progressCalls.push({ text, cardUpdateKey: options?.cardUpdateKey }),
    })).resolves.toEqual(['final answer']);

    const milestoneCalls = progressCalls.filter(call => call.cardUpdateKey === undefined);
    expect(milestoneCalls).toHaveLength(1);
    expect(milestoneCalls[0]!.text).toContain('Result observed');
    // Card-tier milestones (subtask start) never reach the chat.
    expect(milestoneCalls.some(call => call.text.includes('Executing Subtask'))).toBe(false);

    const cardCalls = progressCalls.filter(call => call.cardUpdateKey !== undefined);
    expect(cardCalls).toHaveLength(2); // activity card + completion receipt
    expect(cardCalls[0]!.cardUpdateKey).toBe('feishu-activity:turn:conv_1:req_1');
    expect(cardCalls[0]!.text).toContain('收集视频号数据');
    expect(cardCalls[1]!.text).toContain('任务已完成');
    expect(cardCalls[0]!.text).toContain('收集视频号数据');
  });

  it('resets the live Feishu activity projection when a Conversation starts another Task', async () => {
    const subscriptions = new GatewaySubscriptions();
    const deliveries: FeishuGatewayDelivery[] = [];
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_attach',
          idempotencyKey: 'feishu:req_attach',
          status: 'accepted',
          conversationId: 'conv_1',
          routeKind: 'conversation_attached',
          workspaceId: 'workspace_1',
          connectionId: 'feishu:chat_1:',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal: {
        append: async event => event,
        replay: async (_accountId, streamId) => streamId.includes('workspace_directory')
          ? {
              lastSequence: 1,
              snapshot: [],
              deltas: [workspaceDirectoryEvent({
                items: [conversationSummary('conv_1', '策略评估', 'idle', null)],
                nextCursor: null,
              })],
            }
          : {
              lastSequence: 0,
              snapshot: [],
              deltas: [],
            },
      },
      subscriptions,
      activityCardMinIntervalMs: 0,
    });
    const unsubscribe = port.subscribeGatewayDelivery(delivery => deliveries.push(delivery));

    await port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '/conversation conv_1',
      requestId: 'req_attach',
      onProgress: () => undefined,
    });

    const publishTrace = (
      eventId: string,
      taskId: string,
      subtaskTitle: string,
      turnId: string,
      sequence: number,
    ): void => {
      subscriptions.publish({
        ...finalEvent(),
        eventId,
        sequence,
        requestId: null,
        turnId,
        kind: 'trace_delta',
        payload: {
          turnId,
          taskId,
          events: [{
            id: `${eventId}_item`,
            sequence,
            occurredAt: '2026-09-06T01:00:00.000Z',
            phase: 'execution',
            actor: 'runtime',
            kind: 'subtask_execution_started',
            status: 'running',
            title: `Executing Subtask: ${subtaskTitle}`,
            summary: '',
            details: {},
            taskId,
            subtaskId: `${taskId}_subtask`,
          }],
        },
      }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    };

    publishTrace('event_task_1', 'task_news', '检索新闻', 'turn_news', 1);
    subscriptions.publish({
      ...finalEvent(),
      eventId: 'event_task_2_started',
      sequence: 2,
      requestId: null,
      turnId: 'turn_quant',
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_quant',
        taskId: 'task_quant',
        events: [{
          id: 'event_task_2_started_item',
          sequence: 2,
          occurredAt: '2026-09-06T01:00:01.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: 'Executor progress',
          summary: '量化策略评估已开始',
          details: {},
          taskId: 'task_quant',
        }],
      },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    // A late trace from the completed news Task must not repopulate the
    // activity card for the active quant Task.
    publishTrace('event_late_news', 'task_news', '整理新闻结论', 'turn_news', 3);
    await new Promise(resolve => setTimeout(resolve, 0));

    const cards = deliveries
      .filter(delivery => delivery.kind === 'progress')
      .map(delivery => delivery.reply.lines[0] ?? '');
    expect(cards.length).toBe(2);
    expect(cards.some(card => card.includes('检索新闻'))).toBe(true);
    expect(cards.some(card => card.includes('量化策略评估已开始'))).toBe(true);
    expect(cards.at(-1)).toContain('量化策略评估已开始');
    expect(cards.at(-1)).not.toContain('整理新闻结论');
    unsubscribe();
  });

  it('attaches registered task artifacts to the final reply for cloud-doc delivery', async () => {
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    };
    const adapter = {
      handleMessage: async () => ({
        requestId: 'req_1',
        idempotencyKey: 'feishu:req_1',
        status: 'accepted',
        conversationId: 'conv_1',
      }),
    } as unknown as FeishuGatewayAdapter;
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter,
      journal,
      subscriptions,
      timeoutMs: 500,
      listTaskArtifacts: taskId => (taskId === 'task_1' ? [{
        displayName: '调研报告.md',
        publishedPath: '/tmp/artifacts/调研报告.md',
        mediaType: 'text/markdown',
        previewKind: 'markdown',
      }] : []),
    });
    const origin = { connectionId: 'feishu:chat_1:', surface: 'feishu' as const };
    const taskTrace: GatewayEventEnvelope = {
      ...finalEvent(),
      eventId: 'event_task',
      sequence: 1,
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_1',
        events: [{
          id: 'evt_sub', sequence: 1, occurredAt: '2026-09-05T01:00:00.000Z',
          phase: 'execution', actor: 'runtime', kind: 'subtask_execution_started',
          status: 'running', title: 'Executing Subtask: 调研', summary: '',
          details: {}, taskId: 'task_1', subtaskId: 'sub_1',
        }],
      },
    };
    const submitPromise = port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '调研一下',
      requestId: 'req_1',
      onProgress: () => undefined,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    subscriptions.publish(taskTrace, origin);
    subscriptions.publish(finalEventFor('req_1', 2), origin);
    const reply = await submitPromise;
    expect(Array.isArray(reply)).toBe(false);
    if (Array.isArray(reply)) return;
    expect(reply.artifacts).toEqual([expect.objectContaining({
      name: '调研报告.md',
      previewKind: 'markdown',
    })]);
  });

  it('includes registered artifacts when an attached Task reaches a live terminal event', async () => {
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async (_accountId, streamId) => streamId.includes('workspace_directory')
        ? {
            lastSequence: 1,
            snapshot: [],
            deltas: [workspaceDirectoryEvent({
              items: [conversationSummary('conv_1', 'Live task', 'idle', null)],
              nextCursor: null,
            })],
          }
        : {
            lastSequence: 0,
            snapshot: [],
            deltas: [],
          },
    };
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter: {
        handleMessage: async () => ({
          requestId: 'req_attach',
          idempotencyKey: 'feishu:req_attach',
          status: 'accepted',
          conversationId: 'conv_1',
          workspaceId: 'workspace_1',
          routeKind: 'conversation_attached',
          connectionId: 'feishu:chat_1:',
        }),
      } as unknown as FeishuGatewayAdapter,
      journal,
      subscriptions,
      listTaskArtifacts: taskId => taskId === 'task_news'
        ? [{
            displayName: '隔夜要闻简报_2026-09-06.md',
            publishedPath: '/tmp/隔夜要闻简报_2026-09-06.md',
            mediaType: 'text/markdown',
            previewKind: 'markdown',
          }]
        : [],
    });
    const deliveries: FeishuGatewayDelivery[] = [];
    const unsubscribe = port.subscribeGatewayDelivery(delivery => deliveries.push(delivery));

    await port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: '/conversation conv_1',
      requestId: 'req_attach',
      onProgress: () => undefined,
    });

    subscriptions.publish({
      ...finalEvent(),
      eventId: 'event_news_started',
      requestId: null,
      turnId: 'turn_news',
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_news',
        taskId: 'task_news',
        events: [{
          id: 'event_news_started_item',
          sequence: 1,
          occurredAt: '2026-09-06T01:00:00.000Z',
          phase: 'execution',
          actor: 'runtime',
          kind: 'subtask_execution_started',
          status: 'running',
          title: 'Executing Subtask: 检索隔夜新闻',
          summary: '',
          details: {},
          taskId: 'task_news',
          subtaskId: 'sub_news',
        }],
      },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    subscriptions.publish({
      ...finalEventFor('req_news', 2),
      eventId: 'event_news_final',
      requestId: 'req_news',
      turnId: 'turn_news',
      payload: { lines: ['新闻简报已完成'] },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    await new Promise(resolve => setTimeout(resolve, 0));

    const final = deliveries.find(delivery => delivery.kind === 'final');
    expect(final?.reply.artifacts).toEqual([expect.objectContaining({
      name: '隔夜要闻简报_2026-09-06.md',
      previewKind: 'markdown',
    })]);
    unsubscribe();
  });

});

function finalEvent(): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: 'event_final',
    sequence: 2,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_1',
    turnId: 'turn_1',
    kind: 'final_answer',
    payload: { lines: ['final answer'] },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function finalEventFor(requestId: string, sequence: number): GatewayEventEnvelope {
  return {
    ...finalEvent(),
    eventId: `event_final_${requestId}`,
    sequence,
    requestId,
  };
}

function workspaceSnapshot(path: string, sequence: number): GatewayEventEnvelope {
  return {
    ...finalEventFor('snapshot', sequence),
    eventId: `event_workspace_snapshot_${sequence}`,
    requestId: null,
    turnId: null,
    kind: 'conversation_snapshot',
    payload: {
      from: 0,
      lines: [],
      workspace: {
        path,
        selectedAt: '2026-08-27T08:00:00.000Z',
      },
    },
  };
}

function workspaceChanged(
  path: string,
  sequence: number,
  requestId: string,
): GatewayEventEnvelope {
  return {
    ...workspaceSnapshot(path, sequence),
    eventId: `event_workspace_changed_${sequence}`,
    requestId,
    turnId: 'turn_workspace',
    kind: 'workspace_changed',
    payload: {
      workspace: {
        path,
        selectedAt: '2026-08-27T09:00:00.000Z',
      },
    },
  };
}

function progressEvent(): GatewayEventEnvelope {
  return {
    ...finalEvent(),
    eventId: 'event_progress',
    sequence: 1,
    kind: 'trace_delta',
    payload: {
      events: [{ title: 'Planning', summary: 'Inspecting context' }],
    },
  };
}

function resultEvent(
  sequence: number,
  kind: GatewayEventEnvelope['kind'],
  payload: unknown,
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: `event_${sequence}`,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_1',
    turnId: 'turn_1',
    kind,
    payload,
    occurredAt: '2026-08-21T00:00:00.000Z',
  };
}

function workspaceDirectoryEvent(page: {
  items: unknown[];
  nextCursor: string | null;
}): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: 'event_workspace_directory',
    sequence: 1,
    accountId: 'local-default',
    conversationId: 'workspace_directory_workspace_repo',
    requestId: null,
    turnId: null,
    kind: 'workspace_directory_snapshot',
    payload: {
      workspaceId: 'workspace_repo',
      workspace: {
        id: 'workspace_repo',
        displayName: 'MetaWork',
        canonicalPath: '/repo',
        availability: 'available',
      },
      page,
    },
    occurredAt: '2026-08-27T00:00:00.000Z',
  };
}

function conversationSummary(
  conversationId: string,
  title: string,
  state: string,
  taskId: string | null,
): Record<string, unknown> {
  return {
    conversationId,
    workspaceId: 'workspace_repo',
    title,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T01:00:00.000Z',
    archived: false,
    preview: title,
    activity: {
      state,
      taskId,
      updatedAt: '2026-08-27T01:00:00.000Z',
    },
  };
}

function historyPageEvent(
  turns: unknown[],
  previousCursor: string | null,
  nextCursor: string | null,
  requestId = 'req_history',
  sequence = 1,
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: `event_history_${sequence}`,
    sequence,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId,
    turnId: null,
    kind: 'conversation_history_page',
    payload: {
      turns,
      previousCursor,
      nextCursor,
    },
    occurredAt: '2026-08-27T00:00:00.000Z',
  };
}

function workspaceDirectoryPageEvent(page: {
  items: unknown[];
  nextCursor: string | null;
}, requestId: string | null = null, streamId = 'workspace_directory_workspace_repo'): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: 'event_workspace_page',
    sequence: 2,
    accountId: 'local-default',
    conversationId: streamId,
    requestId,
    turnId: null,
    kind: 'workspace_directory_snapshot',
    payload: {
      workspaceId: 'workspace_repo',
      workspace: {
        id: 'workspace_repo',
        displayName: 'MetaWork',
        canonicalPath: '/repo',
        availability: 'available',
      },
      page,
    },
    occurredAt: '2026-08-27T01:00:00.000Z',
  };
}

function workspaceActivityEvent(
  conversationId: string,
  state: string,
  taskId: string | null,
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: 'event_workspace_activity',
    sequence: 3,
    accountId: 'local-default',
    conversationId: 'workspace_directory_workspace_repo',
    requestId: null,
    turnId: null,
    kind: 'workspace_activity_changed',
    payload: {
      workspaceId: 'workspace_repo',
      conversationId,
      activity: {
        state,
        taskId,
        updatedAt: '2026-08-27T02:00:00.000Z',
      },
    },
    occurredAt: '2026-08-27T02:00:00.000Z',
  };
}

function turn(id: string, userInput: string, finalAnswer: string): Record<string, unknown> {
  return {
    id,
    conversationId: 'conv_1',
    userInput,
    finalAnswer,
    status: 'completed',
  };
}

describe('FeishuGatewaySessionPort late terminal turn isolation (closure round 3)', () => {
  it('ignores a late final_answer whose turnId differs from the active turn', async () => {
    const subscriptions = new GatewaySubscriptions();
    const journal: EventJournal = {
      append: async event => event,
      replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
    };
    const adapter = {
      handleMessage: async () => ({
        requestId: 'req_1',
        idempotencyKey: 'feishu:req_1',
        status: 'accepted',
        conversationId: 'conv_1',
      }),
    } as unknown as FeishuGatewayAdapter;
    const port = new FeishuGatewaySessionPort({
      accountId: 'local-default',
      tenantKey: 'tenant_1',
      adapter,
      journal,
      subscriptions,
      activityCardMinIntervalMs: 0,
    });
    const deliveries: Array<{ kind: string; reply: { lines: string[] } }> = [];
    const unsubscribe = port.subscribeGatewayDelivery(delivery => deliveries.push(
      { kind: delivery.kind, reply: { lines: delivery.reply.lines } },
    ));
    // Establish the live attachment without awaiting the (never-settling)
    // request-scoped terminal promise.
    void port.submitGatewayMessage({
      senderId: 'user_1',
      chatId: 'chat_1',
      text: 'run task',
      requestId: 'req_1',
      onProgress: () => undefined,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Active turn is turn_quant (new task).
    subscriptions.publish({
      ...finalEvent(),
      eventId: 'trace_quant',
      sequence: 1,
      requestId: null,
      turnId: 'turn_quant',
      kind: 'trace_delta',
      payload: {
        turnId: 'turn_quant',
        events: [{
          id: 'trace_quant_item',
          sequence: 1,
          occurredAt: '2026-09-06T01:00:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: '量化任务进行中',
          summary: '',
          details: {},
          taskId: 'task_quant',
        }],
      },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    // A late final_answer from the retired turn_news must NOT emit a final or
    // clear the active quant card.
    subscriptions.publish({
      ...finalEvent(),
      eventId: 'late_final_news',
      sequence: 2,
      requestId: null,
      turnId: 'turn_news',
      kind: 'final_answer',
      payload: { lines: ['新闻任务迟到结论'] },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    // The real terminal for the active turn still arrives and is delivered.
    subscriptions.publish({
      ...finalEvent(),
      eventId: 'final_quant',
      sequence: 3,
      requestId: null,
      turnId: 'turn_quant',
      kind: 'final_answer',
      payload: { lines: ['量化任务结论'] },
    }, { connectionId: 'feishu:chat_1:', surface: 'feishu' });
    await new Promise(resolve => setTimeout(resolve, 0));

    const finals = deliveries.filter(delivery => delivery.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.reply.lines.join('\n')).toContain('量化任务结论');
    expect(finals[0]!.reply.lines.join('\n')).not.toContain('新闻任务迟到结论');
    unsubscribe();
  });
});
