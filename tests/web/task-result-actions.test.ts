import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { GatewayTaskViewSnapshot } from '../../src/gateway/task-view.js';
import type { WsClient } from '../../web/src/api/ws';
import { TaskResultActions } from '../../web/src/components/TaskResultActions';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Task result action presentation', () => {
  function render(actions: string[], delivery?: GatewayTaskViewSnapshot['publicDelivery']) {
    return renderToStaticMarkup(createElement(TaskResultActions, {
      ws: {} as WsClient, conversationId: 'conversation', refresh() {}, delivery,
      lifecycle: { pendingDecision: { owner: 'user', reason: 'uncertified_result', resultId: 'result',
        attemptId: 'attempt', actions, expectedResult: { taskId: 'task', generationId: 'generation',
          graphRevision: 2, subtaskId: 'subtask', attemptId: 'attempt', resultId: 'result' } } } as GatewayTaskViewSnapshot['lifecycle'],
    }));
  }

  it('shows authorized accept and retry controls', () => {
    const html = render(['accept_result', 'retry_attempt']);
    expect(html).toContain('接受并交付');
    expect(html).toContain('重新执行');
  });

  it('hides controls that the authoritative TaskView has not authorized', () => {
    expect(render(['accept_result'])).not.toContain('重新执行');
    expect(render(['retry_attempt'])).not.toContain('接受并交付');
    expect(render([])).not.toContain('<button');
  });

  it('shows actual user paths, relative files and publication conflicts', () => {
    const html = render([], { workspace: '/user/projects', taskDirectory: '/user/projects/service',
      state: 'failed', files: ['src/server.ts'], conflicts: ['package.json'] });
    expect(html).toContain('/user/projects/service');
    expect(html).toContain('src/server.ts');
    expect(html).toContain('发布失败');
    expect(html).toContain('请处理冲突文件后继续：package.json');
  });
});
