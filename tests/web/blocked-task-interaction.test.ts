import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Composer } from '../../web/src/components/Composer';
import { ObservedActivity } from '../../web/src/observation/ObservedActivity';
import { conversationHasOngoingWork, taskActivityMessage, turnHasOngoingWork } from '../../web/src/observation/task-activity';
import type { ConversationTaskSummary } from '../../src/session/conversation-activity-types';

const { renderToStaticMarkup } = createRequire(new URL('../../web/package.json', import.meta.url))('react-dom/server');
const task = (phase: string): ConversationTaskSummary => ({
  taskId: 'task-ppt', title: '客户演示 PPT', phase, executionGeneration: 'generation-1',
  explanation: 'requires explicit recovery', canCancel: true,
  userState: phase === 'executing' || phase === 'publishing' ? 'executing'
    : ['queued', 'retrying', 'waiting_for_plan'].includes(phase) ? 'waiting'
      : ['completed', 'cancelled'].includes(phase) ? 'finished' : 'needs_action',
  userStateReason: '需要处理，请继续未完成部分。',
});

describe('blocked task interaction', () => {
  it.each(['blocked', 'recovery_required', 'waiting_for_user', 'queued', 'retrying', 'waiting_for_plan', 'cancelled', 'completed'])(
    'does not confuse %s cancellation permission or a stale Turn with running work', phase => {
      expect(conversationHasOngoingWork([task(phase)], { status: 'running', taskId: 'task-ppt' })).toBe(false);
    },
  );
  it.each(['executing', 'publishing'])(
    'keeps the stop control for %s work even after a query completes', phase => {
      expect(conversationHasOngoingWork([task('blocked'), { ...task(phase), taskId: 'new-task' }],
        { status: 'completed', taskId: null })).toBe(true);
    },
  );
  it('retains independent Planner activity while an older task is blocked', () => {
    expect(conversationHasOngoingWork([task('blocked')], { status: 'running', taskId: null })).toBe(true);
  });
  it('does not target an old blocked turn when stopping newer work', () => {
    const tasks = [task('blocked'), { ...task('executing'), taskId: 'new-task' }];
    expect(turnHasOngoingWork(tasks, { status: 'running', taskId: 'task-ppt' })).toBe(false);
    expect(turnHasOngoingWork(tasks, { status: 'running', taskId: 'new-task' })).toBe(true);
  });
  it('allows commands during execution and removes the global Stop after blocking', () => {
    for (const phase of ['executing', 'blocked']) {
      const html = renderToStaticMarkup(createElement(Composer, {
        draft: '/task dashboard', disabled: false,
        running: conversationHasOngoingWork([task(phase)], { status: 'running', taskId: 'task-ppt' }),
        attachments: [], onDraftChange() {}, onSend() {}, onCancel() {}, onFilesSelected() {}, onRemoveAttachment() {},
      }));
      expect(html).toContain('<button type="submit">发送</button>');
      expect(html.includes('stop-button')).toBe(phase === 'executing');
      expect(html).not.toContain('执行中');
    }
  });
  it('shows recovery actions in the main Conversation even when normal task cards are hidden', () => {
    const html = renderToStaticMarkup(createElement(ObservedActivity, {
      conversationId: 'conv', view: { tasks: [task('blocked')], nextCursor: null, pendingInteractions: [] },
      showTasks: false, ws: {} as never, http: {} as never,
    }));
    expect(html).toContain('需要处理，请继续未完成部分。');
    expect(html).toContain('继续未完成部分');
    expect(html).toContain('查看 Dashboard');
    expect(html).toContain('查看任务详情');
  });
  it('states that a settling executor is still cleaning up', () => {
    expect(taskActivityMessage({ userStateReason: '等待执行器退出和清理' })).toContain('等待执行器退出和清理');
  });
});
