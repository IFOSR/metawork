import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ConversationTurnView } from '../../web/src/components/ConversationTurn';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import { conversationOutput } from '../../web/src/conversation-output';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function blockedTurn(): ConversationTurnProjection {
  return {
    id: 'turn_blocked',
    sessionId: 'conv_1',
    userInput: '调研目标网站的视频制作能力',
    status: 'blocked',
    finalAnswer: null,
    taskId: 'task_1',
    startedAt: '2026-09-18T07:49:17.351Z',
    completedAt: '2026-09-18T07:50:23.531Z',
    traceEvents: [
      {
        id: 'trace_progress',
        sequence: 1,
        occurredAt: '2026-09-18T07:49:30.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'running',
        title: 'Executor progress: status',
        summary: 'Executor: 我会先按 planning-with-files 的约束建立调查计划。',
        details: { taskId: 'task_1' },
      },
      {
        id: 'trace_failure',
        sequence: 2,
        occurredAt: '2026-09-18T07:50:20.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_result_observed',
        status: 'failed',
        title: 'Executor attempt settled',
        summary: 'Executor failed; Kernel will decide recovery or retry.',
        details: {
          taskId: 'task_1',
          outcome: 'executor_failed',
          failureCode: 'provider_quota_exceeded',
          failureSummary: 'unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.001796',
          failureLabel: '模型服务额度不足（provider 拒绝计费），请充值或切换模型后重试',
          failureStep: 'command_execution: python3 session-catchup.py',
          failureProvider: { httpStatus: 403 },
        },
      },
    ],
    artifactRefs: [],
    artifacts: [],
    executionTimeline: null,
  } as unknown as ConversationTurnProjection;
}

describe('Conversation turn failure passthrough', () => {
  it('separates repeated runtime receipts from business results without consuming fenced examples', () => {
    const receipt = 'Execution needs attention: no runnable Subtask while work remains';
    const output = conversationOutput([
      '### 已完成的调研', '保留这份部分结果。',
      '【Executor: 分析师｜派发准备】', '→ Executor: 分析师 将处理该任务', receipt,
      '┌─ 任务队列前五 ─┐', '│ 1. 内部 task_identifier', '└──────────────┘',
      receipt, '### 后续说明', '正文仍然保留。', '```text', receipt, '```',
    ].join('\n'));
    expect(output.body).toContain('保留这份部分结果。');
    expect(output.body).toContain('正文仍然保留。');
    expect(output.body).toContain(`\x60\x60\x60text\n${receipt}\n\x60\x60\x60`);
    expect(output.body).not.toContain('内部 task_identifier');
    expect(output.body).not.toContain('派发准备');
    expect(output.receipts.filter(line => line === receipt)).toHaveLength(1);
    const queue = '┌─ 任务队列前五 ─┐\n│ snapshot\n└────┘';
    expect(conversationOutput([queue, queue].join('\n')).receipts).toEqual([queue]);
    expect(conversationOutput('┌─ 任务队列前五 ─┐\n│ snapshot\n保留后续结果。').body).toBe('保留后续结果。');
  });

  it('explains configuration failure once, lists downstream impact and folds raw receipts', () => {
    const turn = blockedTurn();
    turn.traceEvents[1].details = {
      failureCode: 'executor_configuration_failed',
      failureSummary: 'Executor configuration content mismatch: .pi/agent/models.json',
      failureStage: 'attempt',
    };
    turn.finalAnswer = ['【Executor: 分析师｜派发准备】',
      'Execution needs attention: dependency materialization failed: long_internal_task_id',
      '┌─ 任务队列前五 ─┐', '│ internal queue', '└──────────────┘'].join('\n');
    turn.executionTimeline = {
      taskId: 'task_1', title: '客户介绍方案', status: 'blocked', userState: 'needs_action', userStateReason: '需要处理',
      stages: [{ phase: 'planning', status: 'done', proposal: { subtasks: ['官网调研', '方案撰写'], dependencies: [['research', 'writing']] } },
        { phase: 'execution', status: 'blocked', subtasks: [
          { id: 'research', title: '官网调研', status: 'blocked', attempts: [] },
          { id: 'writing', title: '方案撰写', status: 'blocked', attempts: [] },
        ] }],
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));
    expect(html).toContain('执行配置校验未通过');
    expect(html).toContain('等待上游结果');
    expect(html).toContain('继续未完成部分');
    expect(html).toContain('<details class="execution-notice-details">');
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('<section class="final-answer">');
    expect(html.match(/execution-notice-heading/g)).toHaveLength(1);
  });

  it('shows the Executor failure text, code and step on a blocked turn', () => {
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn: blockedTurn() }));

    expect(html).toContain('需要处理');
    expect(html).toContain('模型服务额度不足');
    expect(html).toContain('unexpected status 403 Forbidden: 用户额度不足');
    expect(html).toContain('provider_quota_exceeded');
    expect(html).toContain('步骤：command_execution');
    expect(html).toContain('HTTP 403');
  });

  it('keeps the configuration cause visible when the latest failure is a downstream dependency', () => {
    const turn = blockedTurn();
    turn.traceEvents[1].details = { failureSummary: 'dependency materialization failed: upstream blocked' };
    turn.finalAnswer = 'Execution needs attention: Executor configuration content mismatch: .pi/agent/models.json';
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));
    expect(html).toContain('执行配置校验未通过');
    expect(html).toContain('dependency materialization failed');
  });

  it('recognizes the scoped effective-configuration mismatch reason', () => {
    const turn = blockedTurn();
    turn.traceEvents[1].details = {
      failureSummary: 'Executor configuration mismatch: selected Provider',
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));
    expect(html).toContain('执行配置校验未通过');
  });

  it('does not render a failure block for a completed turn', () => {
    const turn = { ...blockedTurn(), status: 'completed' as const };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).not.toContain('unexpected status 403 Forbidden');
  });

  it('shows the execution stage and bounded recovery facts for an interrupted upstream stream', () => {
    const turn = {
      ...blockedTurn(),
      traceEvents: [{
        id: 'trace_stream_interrupted',
        sequence: 3,
        occurredAt: '2026-09-18T07:50:20.000Z',
        phase: 'execution' as const,
        actor: 'executor' as const,
        kind: 'executor_result_observed',
        status: 'failed' as const,
        title: 'Executor attempt settled',
        summary: 'Executor failed; Kernel will decide recovery or retry.',
        details: {
          failureCode: 'upstream_stream_interrupted',
          failureSummary: 'Upstream response stream was interrupted',
          failureLabel: '上游模型响应流中断，未收到可用结果',
          failureStage: 'attempt',
          failureRetryable: true,
          attemptStarted: true,
          externalSideEffect: 'unknown',
          userAction: '系统会自动重试一次',
        },
      }],
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).toContain('上游模型响应流中断');
    expect(html).toContain('阶段：Executor 调用');
    expect(html).toContain('恢复：可自动重试');
    expect(html).toContain('Executor：已启动');
    expect(html).toContain('副作用：未知');
    expect(html).toContain('系统会自动重试一次');
  });

  it('infers the same diagnosis for a historical receipt without new failure fields', () => {
    const turn = {
      ...blockedTurn(),
      traceEvents: [{
        id: 'trace_historical_stream_interrupted',
        sequence: 3,
        occurredAt: '2026-09-18T07:50:20.000Z',
        phase: 'execution' as const,
        actor: 'executor' as const,
        kind: 'executor_result_observed',
        status: 'failed' as const,
        title: 'Executor attempt settled',
        summary: 'Executor failed; Kernel will decide recovery or retry.',
        details: {
          failureCode: 'unknown_executor_failure',
          failureSummary: 'Upstream response stream was interrupted',
        },
      }],
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).toContain('上游模型响应流中断，未收到可用结果');
    expect(html).toContain('阶段：Executor 调用');
    expect(html).toContain('恢复：可自动重试');
  });

  it('labels a retry wake as waiting for automatic retry instead of a manual block', () => {
    const turn = {
      ...blockedTurn(),
      traceEvents: [{
        id: 'trace_waiting_retry',
        sequence: 3,
        occurredAt: '2026-09-18T07:50:20.000Z',
        phase: 'verification' as const,
        actor: 'kernel' as const,
        kind: 'execution_waiting_retry',
        status: 'blocked' as const,
        title: '等待自动重试',
        summary: '上游执行暂时不可用，系统将在稍后自动重试。',
        details: {},
      }],
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).toContain('等待自动重试');
  });

  it('shows a recovery notice after automatic capacity recovery', () => {
    const turn = {
      ...blockedTurn(),
      status: 'running' as const,
      completedAt: null,
      traceEvents: [
        ...blockedTurn().traceEvents,
        {
          id: 'trace_resumed',
          sequence: 3,
          occurredAt: '2026-09-18T07:51:00.000Z',
          phase: 'execution' as const,
          actor: 'kernel' as const,
          kind: 'execution_resumed',
          status: 'running' as const,
          title: 'Task resumed execution',
          summary: '容量已恢复，已恢复分析师执行。',
          details: { taskId: 'task_1' },
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).toContain('已恢复执行');
    expect(html).not.toContain('模型服务额度不足');
  });
});
