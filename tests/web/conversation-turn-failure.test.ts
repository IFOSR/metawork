import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ConversationTurnView } from '../../web/src/components/ConversationTurn';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';

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
  it('shows the Executor failure text, code and step on a blocked turn', () => {
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn: blockedTurn() }));

    expect(html).toContain('已阻塞');
    expect(html).toContain('模型服务额度不足');
    expect(html).toContain('unexpected status 403 Forbidden: 用户额度不足');
    expect(html).toContain('provider_quota_exceeded');
    expect(html).toContain('步骤：command_execution');
    expect(html).toContain('HTTP 403');
  });

  it('does not render a failure block for a completed turn', () => {
    const turn = { ...blockedTurn(), status: 'completed' as const };
    const html = renderToStaticMarkup(createElement(ConversationTurnView, { turn }));

    expect(html).not.toContain('unexpected status 403 Forbidden');
  });
});
