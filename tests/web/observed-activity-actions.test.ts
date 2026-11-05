import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { ConversationTaskSummary } from '../../src/session/conversation-activity-types.js';
import { ObservedActivity } from '../../web/src/observation/ObservedActivity';

const { renderToStaticMarkup } = createRequire(new URL('../../web/package.json', import.meta.url))('react-dom/server');
const reason = { code: 'result_acceptance_required' as const, message: '结果未通过完成验收', evidenceRefs: [] };
const expected = { taskId: 'task', generationId: 'generation', graphRevision: 1,
  subtaskId: 'final', attemptId: 'attempt', resultId: 'safe' };
const task: ConversationTaskSummary = {
  taskId: 'task', title: '生成报告', executionGeneration: 'generation', graphRevision: 1,
  status: 'needs_action', statusLabel: '需要处理', stateVersion: 3, reason,
  phase: null, pendingActions: [], nextAuthorizedAction: 'await_user_input', explanation: reason.message, canCancel: true,
};
function render(overrides: Partial<ConversationTaskSummary>) {
  return renderToStaticMarkup(createElement(ObservedActivity, {
    conversationId: 'conversation', ws: {} as never, http: {} as never,
    view: { tasks: [{ ...task, ...overrides }], nextCursor: null, pendingInteractions: [] },
  }));
}

describe('activity recovery controls', () => {
  it('presents exact result acceptance and retry instead of a generic continuation', () => {
    const html = render({ nextAuthorizedAction: 'accept_result', pendingActions: [
      { actionId: 'accept', kind: 'accept_result', label: '接受', reason, result: expected },
      { actionId: 'retry', kind: 'retry_attempt', label: '重试', reason, result: expected },
    ] });
    expect(html).toContain('接受并交付');
    expect(html).toContain('重新执行');
    expect(html).toContain('结果尚未通过完整验收');
    expect(html).not.toContain('只有你认为结果不正确时');
    expect(html).not.toContain('继续未完成部分');
  });
  it('does not invent a continuation when only a needs_action status is known', () => {
    expect(render({})).not.toContain('继续未完成部分');
    expect(render({ nextAuthorizedAction: 'explicit_resume_required' })).toContain('继续未完成部分');
  });
});
