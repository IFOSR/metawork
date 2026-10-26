import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BlockedActions } from '../../web/src/components/BlockedActions';

const { renderToStaticMarkup } = createRequire(new URL('../../web/package.json', import.meta.url))('react-dom/server');
const ws = { control: vi.fn(), sendCommand: vi.fn() } as never;

describe('inline blocked actions', () => {
  it('offers authorization right where the Turn is blocked', () => {
    const html = renderToStaticMarkup(createElement(BlockedActions, {
      ws,
      conversationId: 'conv_1',
      taskId: 'task_1',
      lifecycle: {
        lifecycle: 'blocked', phase: 'waiting_for_user', userState: 'needs_action',
        userStateReason: '等待授权后继续', activeAttempt: null, blockingResidue: [],
        nextAuthorizedAction: 'resolve_permission', recoveryDiagnosis: null, explanation: '',
        lastProgressAt: null, lastAttemptSettledAt: null, nextWakeAt: null,
      },
      permission: { requestId: 'perm_1', requestRevision: 'rev_1', generationId: 'generation_1',
        status: 'pending', summary: 'network example.com' },
    }));
    expect(html).toContain('等待你的授权');
    expect(html).toContain('同意并继续');
    expect(html).toContain('拒绝');
  });

  it('offers a recovery entry point for a blocked Task without a permission request', () => {
    const html = renderToStaticMarkup(createElement(BlockedActions, {
      ws,
      conversationId: 'conv_1',
      taskId: 'task_1',
      lifecycle: {
        lifecycle: 'blocked', phase: 'recovery_required', userState: 'needs_action',
        userStateReason: '上次执行结果不确定', activeAttempt: null, blockingResidue: ['unknown'],
        nextAuthorizedAction: 'resume', recoveryDiagnosis: 'unknown blocker', explanation: '',
        lastProgressAt: null, lastAttemptSettledAt: null, nextWakeAt: null,
      },
      permission: null,
    }));
    expect(html).toContain('需要你的处理才能继续');
    expect(html).toContain('继续未完成部分');
    expect(html).toContain('查看恢复项');
  });

  it('renders nothing when the Turn needs no decision', () => {
    const html = renderToStaticMarkup(createElement(BlockedActions, {
      ws, conversationId: 'conv_1', taskId: 'task_1',
      lifecycle: {
        lifecycle: 'running', phase: 'executing', userState: 'executing',
        userStateReason: '', activeAttempt: null, blockingResidue: [],
        nextAuthorizedAction: 'none', recoveryDiagnosis: null, explanation: '',
        lastProgressAt: null, lastAttemptSettledAt: null, nextWakeAt: null,
      },
      permission: null,
    }));
    expect(html).not.toContain('blocked-actions');
  });

  it('offers the isolated candidate acceptance action', () => {
    const html = renderToStaticMarkup(createElement(BlockedActions, {
      ws,
      conversationId: 'conv_1',
      taskId: 'task_1',
      lifecycle: {
        status: 'needs_action',
        reason: { code: 'input_required', message: '候选变更等待接受', evidenceRefs: [] },
        pendingActions: [{
          actionId: 'accept_delivery:publication_1',
          kind: 'accept_result',
          label: '接受候选变更并发布到工作区',
          reason: { code: 'input_required', message: '候选变更等待接受', evidenceRefs: [] },
          result: null,
          publicationId: 'publication_1',
        }],
        nextAuthorizedAction: 'accept_result',
      },
      permission: null,
    } as never));
    expect(html).toContain('接受候选并发布');
  });
});
