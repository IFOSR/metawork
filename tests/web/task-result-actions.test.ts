import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { GatewayTaskViewSnapshot } from '../../src/gateway/task-view.js';
import type { HttpClient } from '../../web/src/api/http';
import type { WsClient } from '../../web/src/api/ws';
import { BlockedActions } from '../../web/src/components/BlockedActions';
import { TaskResultActions } from '../../web/src/components/TaskResultActions';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

const expectedResult = {
  taskId: 'task', generationId: 'generation', graphRevision: 2,
  subtaskId: 'subtask', attemptId: 'attempt', resultId: 'result',
};

function lifecycle(input: {
  actions: readonly ('accept_result' | 'retry_attempt' | 'resolve_recovery')[];
  nextAuthorizedAction: string;
  reason?: string;
  userState?: 'waiting' | 'executing' | 'needs_action' | 'finished';
}): GatewayTaskViewSnapshot['lifecycle'] {
  return {
    userState: input.userState ?? 'needs_action',
    userStateReason: input.reason ?? '结果已通过安全校验并保存，只差完成验收。',
    nextAuthorizedAction: input.nextAuthorizedAction,
    pendingDecision: input.actions.length === 0 ? null : {
      owner: 'user', reason: 'uncertified_result', resultId: 'result', attemptId: 'attempt',
      actions: input.actions, expectedResult,
    },
  } as GatewayTaskViewSnapshot['lifecycle'];
}

function renderDelivery(delivery?: GatewayTaskViewSnapshot['publicDelivery']) {
  return renderToStaticMarkup(createElement(TaskResultActions, { delivery }));
}

function renderBlocked(input: {
  actions: readonly ('accept_result' | 'retry_attempt' | 'resolve_recovery')[];
  nextAuthorizedAction: string;
  reason?: string;
  userState?: 'waiting' | 'executing' | 'needs_action' | 'finished';
}) {
  return renderToStaticMarkup(createElement(BlockedActions, {
    ws: {} as WsClient,
    http: {} as HttpClient,
    conversationId: 'conversation',
    taskId: 'task',
    lifecycle: lifecycle(input),
  }));
}

describe('Task result action presentation', () => {
  it('renders the accept / retry decision once, in the blocked card', () => {
    const html = renderBlocked({ actions: ['accept_result', 'retry_attempt'], nextAuthorizedAction: 'accept_result' });
    expect(html).toContain('接受并交付');
    expect(html).toContain('重新执行');
    // Accept is the recommended action, so it is the highlighted one.
    expect(html).toMatch(/class="primary"[^>]*>接受并交付/u);
  });

  it('names the recommended button so the user does not have to guess', () => {
    expect(renderBlocked({ actions: ['accept_result', 'retry_attempt'], nextAuthorizedAction: 'accept_result' }))
      .toContain('下一步：点「接受并交付」');
    expect(renderBlocked({ actions: ['retry_attempt'], nextAuthorizedAction: 'retry_attempt' }))
      .toContain('下一步：点「重新执行」');
    expect(renderBlocked({ actions: [], nextAuthorizedAction: 'explicit_resume_required' }))
      .toContain('下一步：点「继续未完成部分」');
  });

  it('hides actions the authoritative TaskView has not authorized', () => {
    // The recommendation sentence may still mention the alternative, so the
    // assertion is about rendered buttons only.
    const buttonLabels = (html: string): string[] =>
      [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/gu)].map(match => match[1]!.trim());
    expect(buttonLabels(renderBlocked({ actions: ['accept_result'], nextAuthorizedAction: 'accept_result' })))
      .not.toContain('重新执行');
    expect(buttonLabels(renderBlocked({ actions: ['retry_attempt'], nextAuthorizedAction: 'retry_attempt' })))
      .not.toContain('接受并交付');
  });

  it('does not repeat the decision buttons in the delivery card', () => {
    const html = renderDelivery({
      workspace: '/user/projects', taskDirectory: '/user/projects/service',
      mode: 'worktree', state: 'failed', stateLabel: '发布失败',
      files: ['src/server.ts'], conflicts: ['package.json'],
    });
    expect(html).not.toContain('接受并交付');
    expect(html).not.toContain('重新执行');
  });

  it('shows actual user paths, relative files and publication conflicts', () => {
    const html = renderDelivery({
      workspace: '/user/projects', taskDirectory: '/user/projects/service',
      mode: 'worktree', state: 'failed', stateLabel: '发布失败',
      files: ['src/server.ts'], conflicts: ['package.json'],
    });
    expect(html).toContain('/user/projects/service');
    expect(html).toContain('src/server.ts');
    expect(html).toContain('发布失败');
    expect(html).toContain('请处理冲突文件后继续：package.json');
  });
});
