import { createElement } from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isOfficialAuthorizationBlock, userFacingBlockReason } from '../../web/src/block-reason';
import { collectExecutionCards } from '../../web/src/components/LiveExecutionPanel';
import { BlockedActions } from '../../web/src/components/BlockedActions';
import type { ExecutionTimeline } from '../../web/src/api/types';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('user-facing block reason', () => {
  it('explains the official-account gate instead of printing its code', () => {
    expect(userFacingBlockReason('official authorization state: logged_out'))
      .toBe('需要登录 MetaWork 官方账号后才能继续执行（当前未登录）。');
    expect(isOfficialAuthorizationBlock('official authorization state: logged_out')).toBe(true);
    expect(userFacingBlockReason('official_authorization_required'))
      .toContain('登录并确认官方账号权益');
  });

  it('passes an unknown reason through unchanged', () => {
    expect(userFacingBlockReason('需要补充材料')).toBe('需要补充材料');
    expect(userFacingBlockReason('')).toBe('');
    expect(isOfficialAuthorizationBlock('需要补充材料')).toBe(false);
  });

  it('shows the current block in the blocked notice with a login next step', () => {
    const html = renderToStaticMarkup(createElement(BlockedActions, {
      lifecycle: {
        status: 'needs_action',
        reason: { code: 'input_required', message: 'official authorization state: logged_out' },
        pendingActions: [],
        executionGeneration: 'generation_1',
      },
      conversationId: 'conv_1',
      taskId: 'task_1',
      ws: {} as never,
      refresh: () => undefined,
    } as never));
    expect(html).toContain('需要登录 MetaWork 官方账号后才能继续执行');
    expect(html).toContain('登录 / 注册');
    expect(html).not.toContain('official authorization state');
  });

  it('does not keep narrating a stale partition step on a blocked card', () => {
    const timeline = {
      taskId: 'task_1',
      title: 'PPT',
      status: 'needs_action',
      statusLabel: '待处理',
      stateVersion: 6,
      reasonCode: 'input_required',
      reasonMessage: 'official authorization state: logged_out',
      explanation: '',
      stages: [{
        phase: 'execution',
        status: 'blocked',
        subtasks: [{
          id: 'compose',
          title: '创作七言绝句并制作 PPT',
          status: 'ready',
          attempts: [{
            attemptId: 'attempt_1', attemptKind: 'primary', attemptOrdinal: 1, attemptLabel: '主执行',
            displayStatus: '未执行', result: 'not_started', status: 'terminal',
            startedAt: '2026-10-28T13:55:15.877Z', updatedAt: '2026-10-28T13:55:15.889Z',
          }],
        }],
      }],
    } as unknown as ExecutionTimeline;
    const cards = collectExecutionCards([{
      id: 'partition', sequence: 5, occurredAt: '2026-10-28T13:55:15.889Z', phase: 'authorization',
      actor: 'kernel', kind: 'kernel_waiting_for_partition', status: 'blocked',
      title: 'Kernel is waiting for a resource partition', summary: '', taskId: 'task_1',
      subtaskId: 'compose', details: { stepKey: 'kernel_waiting_for_partition',
        stepLabel: '已阻塞：Kernel is waiting for a resource partition' },
    } as unknown as Parameters<typeof collectExecutionCards>[0][number]], timeline);
    expect(cards[0].stepLabel).toBe('需要登录 MetaWork 官方账号后才能继续执行（当前未登录）。');
    expect(cards[0].activityStatus).toBe('blocked');
  });
});
