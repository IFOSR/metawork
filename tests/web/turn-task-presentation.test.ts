import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { collectExecutionCards, LiveExecutionPanel } from '../../web/src/components/LiveExecutionPanel';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import type { ExecutionTimeline, WorkGraphPresentationProjection } from '../../web/src/api/types';
import { projectTurnForPresentation } from '../../web/src/turn-task-presentation';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Turn Task presentation', () => {
  it('does not announce an Executor start before an attempt exists', () => {
    const cards = collectExecutionCards([], { taskId: 't', title: 'Invoices', status: 'running', stages: [
      { phase: 'execution', status: 'running', subtasks: [
        { id: 'summarize', title: '分类统计', status: 'ready', attempts: [] },
      ] },
    ] });
    expect(cards[0].stepLabel).toContain('等待前置结果');
    expect(cards[0].stepLabel).not.toContain('已启动');
    expect(cards[0].startedAt).toBeNull();
  });

  it('does not let presentation heartbeats overwrite the time of actual progress', () => {
    const cards = collectExecutionCards([{
      id: 'heartbeat', sequence: 1, occurredAt: '2026-10-06T12:00:00Z', phase: 'execution',
      actor: 'runtime', kind: 'executor_heartbeat', status: 'running', title: 'heartbeat', summary: '',
      taskId: 't', subtaskId: 's', details: { lastProgressAt: '2026-10-06T09:00:00Z',
        activityState: 'presentation_heartbeat', operationHealth: { state: 'unknown', lastActivityAt: '2026-10-06T09:00:00Z' } },
    }], { taskId: 't', title: 'Invoices', status: 'running', stages: [
      { phase: 'execution', status: 'running', subtasks: [{ id: 's', title: '读取', status: 'running', attempts: [] }] },
    ] });
    expect(cards[0].lastProgressAt).toBe('2026-10-06T09:00:00Z');
    expect(cards[0].lastActivityAt).toBe('2026-10-06T09:00:00Z');
    expect(cards[0].healthText).toContain('状态待确认');
  });

  it('keeps the newest durable progress timestamp when trace events are older', () => {
    const cards = collectExecutionCards(
      [{
        id: 'route_old',
        sequence: 1,
        occurredAt: '2026-09-30T09:30:00.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_routed',
        status: 'completed',
        title: 'Executor routed',
        summary: '',
        taskId: 'task_b',
        subtaskId: 'subtask_b1',
        details: {},
      }],
      {
        taskId: 'task_b',
        title: 'Task B',
        status: 'running',
        stages: [{
          phase: 'execution',
          status: 'running',
          subtasks: [{
            id: 'subtask_b1',
            title: 'Current B1',
            status: 'running',
            attempts: [{
              attemptId: 'attempt_b1',
              attemptKind: 'primary',
              attemptOrdinal: 1,
              attemptLabel: '主执行',
              displayStatus: '执行中',
              result: 'running',
              startedAt: '2026-09-30T09:00:00.000Z',
              updatedAt: '2026-09-30T10:00:00.000Z',
              progressHistory: [{
                kind: 'log',
                text: '正在执行',
                occurredAt: '2026-09-30T10:00:00.000Z',
              }],
            }],
          }],
        }],
      },
    );

    expect(cards[0]?.updatedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('does not let a previous Attempt terminal event overwrite a retried Attempt card', () => {
    const cards = collectExecutionCards([{
      id: 'old_contract_failure',
      sequence: 7,
      occurredAt: '2026-10-21T06:09:19.850Z',
      phase: 'verification',
      actor: 'executor',
      kind: 'executor_result_observed',
      status: 'completed',
      title: 'Executor attempt settled',
      summary: 'Executor returned a result that Runtime is certifying for delivery.',
      taskId: 'task_retry',
      subtaskId: 'subtask-ui',
      attemptId: 'attempt-old',
      details: {
        taskId: 'task_retry',
        subtaskId: 'subtask-ui',
        attemptId: 'attempt-old',
        outcome: 'contract_failed',
        stepLabel: '执行结束：contract_failed',
      },
    }], {
      taskId: 'task_retry',
      title: 'Retry',
      status: 'running',
      stages: [{
        phase: 'execution',
        status: 'running',
        subtasks: [{
          id: 'subtask-ui',
          title: '实现多模态决策对话 Web 界面',
          status: 'running',
          attempts: [{
            attemptId: 'attempt-new',
            attemptKind: 'primary',
            attemptOrdinal: 3,
            attemptLabel: '主执行',
            displayStatus: '执行中',
            result: 'running',
          }],
        }],
      }],
    });

    expect(cards[0]).toMatchObject({
      state: 'running',
      activeAttemptId: 'attempt-new',
      stepLabel: '执行器已启动，等待实际进度…',
    });
    expect(cards[0]?.stepLabel).not.toContain('contract_failed');
  });

  it('explains the pre-Executor preparation stage instead of showing an opaque wait', () => {
    const now = new Date().toISOString();
    const turn = {
      id: 'turn_preparing', sessionId: 'conv_1', userInput: '整理资料', status: 'running',
      finalAnswer: null, taskId: 'task_preparing', startedAt: now, completedAt: null,
      traceEvents: [], artifactRefs: [], artifacts: [],
      executionTimeline: { taskId: 'task_preparing', title: '整理资料', status: 'running', stages: [{
        phase: 'execution', status: 'running', subtasks: [{ id: 's', title: '整理资料', status: 'running',
          attempts: [{ attemptKind: 'primary', attemptOrdinal: 1, attemptLabel: '主执行', displayStatus: '执行中',
            result: 'running', startedAt: now, updatedAt: now,
            progressHistory: [{ kind: 'status', text: '工作区与输入资料已准备，正在生成 Executor 执行上下文', occurredAt: now }] }],
        }],
      }] },
    } as ConversationTurnProjection;

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('Executor 尚未启动');
    expect(html).toContain('正在创建工作区、整理输入资料并生成执行上下文');
  });

  it('keeps card state independent when a Turn contains completed and active Subtasks', () => {
    const turn = {
      id: 'turn_mixed', sessionId: 'conv_1', userInput: '生成演示文稿', status: 'completed',
      finalAnswer: '已交付', taskId: 'task_mixed', startedAt: '2026-10-20T09:00:00Z',
      completedAt: '2026-10-20T09:30:00Z', traceEvents: [], artifactRefs: [], artifacts: [],
      executionTimeline: { taskId: 'task_mixed', title: '生成演示文稿', status: 'done', stages: [{
        phase: 'execution', status: 'running', subtasks: [
          { id: 'done', title: '检查结构', status: 'done', attempts: [{ attemptKind: 'primary', attemptOrdinal: 1,
            attemptLabel: '主执行', displayStatus: '已完成', result: 'success' }] },
          { id: 'running', title: '生成文件', status: 'running', attempts: [{ attemptKind: 'primary', attemptOrdinal: 1,
            attemptLabel: '主执行', displayStatus: '执行中', result: 'running', startedAt: '2026-10-20T09:29:00Z' }] },
          { id: 'waiting', title: '交付文件', status: 'ready', attempts: [] },
        ],
      }] },
    } as ConversationTurnProjection;

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('data-state="completed"');
    expect(html).toContain('data-state="running"');
    expect(html).toContain('data-state="waiting"');
    expect(html).toContain('已完成');
    expect(html).toContain('执行中');
    expect(html).toContain('等待启动');
  });

  it('shows every current-Task Subtask but excludes a foreign Task trace card', () => {
    const turn: ConversationTurnProjection = {
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'done',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [
        {
          id: 'task_b_progress',
          sequence: 1,
          occurredAt: '2026-09-10T09:01:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: 'Task B progress',
          summary: 'current',
          taskId: 'task_b',
          subtaskId: 'subtask_b1',
          details: {
            taskId: 'task_b',
            subtaskId: 'subtask_b1',
            subtaskTitle: 'Current B1',
          },
        },
        {
          id: 'task_a_progress',
          sequence: 2,
          occurredAt: '2026-09-10T08:59:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'completed',
          title: 'Task A progress',
          summary: 'old',
          taskId: 'task_a',
          subtaskId: 'subtask_a',
          details: {
            taskId: 'task_a',
            subtaskId: 'subtask_a',
            subtaskTitle: 'Historical A',
          },
        },
      ],
      executionTimeline: {
        taskId: 'task_b',
        title: 'Task B',
        status: 'done',
        stages: [{
          phase: 'execution',
          status: 'done',
          subtasks: [
            {
              id: 'subtask_b1',
              title: 'Current B1',
              status: 'done',
              attempts: [],
            },
            {
              id: 'subtask_b2',
              title: 'Current B2',
              status: 'done',
              attempts: [],
            },
          ],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    } as ConversationTurnProjection;

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('Current B1');
    expect(html).toContain('Current B2');
    expect(html).not.toContain('Historical A');
  });

  it('uses Work Graph Subtask titles instead of stale duplicate trace titles', () => {
    const timeline = {
      taskId: 'task_graph', title: '快速构建服务', status: 'running',
      stages: [{ phase: 'execution' as const, status: 'running' as const, subtasks: [
        { id: 'sub_1', title: '快速构建服务', status: 'ready', attempts: [] },
        { id: 'sub_2', title: '快速构建服务', status: 'ready', attempts: [] },
        { id: 'sub_3', title: 'Rust 服务端与 System One 协议层', status: 'running', attempts: [] },
      ] }],
    } as ExecutionTimeline;
    const events = ['sub_1', 'sub_2', 'sub_3'].map((subtaskId, sequence) => ({
      id: `route_${subtaskId}`, sequence, occurredAt: '2026-10-20T09:00:00Z', phase: 'routing' as const,
      actor: 'kernel' as const, kind: 'executor_routed', status: 'completed' as const,
      title: 'Primary Executor authorized', summary: '', taskId: 'task_graph', subtaskId,
      details: { subtaskId, subtaskTitle: '快速构建服务' },
    }));
    const graph = {
      generationId: 'generation_1', edges: [], parallelGroups: [], currentRunnableFrontier: [],
      nodes: [
        { id: 'sub_1', title: 'Rust 服务端与 System One 协议层' },
        { id: 'sub_2', title: '决策对话单页界面' },
        { id: 'sub_3', title: '端到端自验与缺陷修复' },
      ],
    } as WorkGraphPresentationProjection;

    const cards = collectExecutionCards(events, timeline, graph);

    expect(cards.map(card => card.subtaskTitle)).toEqual([
      'Rust 服务端与 System One 协议层', '决策对话单页界面', '端到端自验与缺陷修复',
    ]);
  });

  it('uses the Task title when a Subtask title is an internal canonical ID', () => {
    const internalSubtaskId = 'task_plan_event_proposal_abc123_r1_shanghai-national-day';
    const turn: ConversationTurnProjection = {
      id: 'turn_title',
      sessionId: 'conv_1',
      userInput: '国庆期间我想去上海周边转一转，有什么可推荐的地方吗？',
      status: 'running',
      finalAnswer: null,
      taskId: 'task_plan_event_proposal_abc123',
      startedAt: '2026-09-30T09:00:00.000Z',
      completedAt: null,
      traceEvents: [],
      executionTimeline: {
        taskId: 'task_plan_event_proposal_abc123',
        title: '国庆上海周边旅行建议',
        status: 'running',
        stages: [{
          phase: 'execution',
          status: 'running',
          subtasks: [{
            id: internalSubtaskId,
            title: internalSubtaskId,
            status: 'running',
            attempts: [],
          }],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    };

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('国庆上海周边旅行建议');
    expect(html).not.toContain(internalSubtaskId);
  });

  it('drops a mismatched historical Timeline instead of replacing the Turn Task', () => {
    const turn = {
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'done',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [],
      executionTimeline: {
        taskId: 'task_a',
        title: 'Task A',
        status: 'done',
        stages: [],
      },
      artifactRefs: [],
      artifacts: [],
    } as ConversationTurnProjection;

    expect(projectTurnForPresentation(turn)).toMatchObject({
      taskId: 'task_b',
      executionTimeline: null,
    });
  });

  it('does not report a yielded Attempt as a completed Subtask', () => {
    // The Workspace write lease made this Subtask wait: its dispatch item is no
    // longer active (terminal) but no receipt or runtime exists. The card must
    // keep the canonical Subtask status and show a waiting state, not "已完成".
    const cards = collectExecutionCards([], { taskId: 't', title: 'Site', status: 'needs_action', stages: [
      { phase: 'execution', status: 'blocked', subtasks: [{
        id: 'start-site', title: '启动网站', status: 'ready', attempts: [{
          attemptId: 'attempt_yielded',
          attemptKind: 'primary',
          attemptOrdinal: 1,
          attemptLabel: '主执行',
          displayStatus: '状态未知',
          result: 'unknown',
          status: 'terminal',
          startedAt: '2026-10-28T06:00:00.000Z',
          updatedAt: '2026-10-28T06:00:00.225Z',
        }],
      }] },
    ] });
    expect(cards[0].state).toBe('waiting');
    expect(cards[0].executionStartedAt).toBeNull();
    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, {
      turn: {
        id: 'turn_1', sessionId: 'session_1', status: 'blocked', taskId: 't',
        traceEvents: [], executionTimeline: {
          taskId: 't', title: 'Site', status: 'needs_action', statusLabel: '需要处理',
          stateVersion: 1, reasonCode: 'none', explanation: '', stages: [
            { phase: 'execution', status: 'blocked', subtasks: [{
              id: 'start-site', title: '启动网站', status: 'ready', attempts: [{
                attemptId: 'attempt_yielded', attemptKind: 'primary', attemptOrdinal: 1,
                attemptLabel: '主执行', displayStatus: '状态未知', result: 'unknown',
                status: 'terminal', startedAt: '2026-10-28T06:00:00.000Z',
                updatedAt: '2026-10-28T06:00:00.225Z',
              }],
            }] },
          ],
        },
      } as unknown as ConversationTurnProjection,
    }));
    expect(html).toContain('等待启动');
    expect(html).not.toContain('已完成');
    expect(html).not.toContain('0s');
  });
});
