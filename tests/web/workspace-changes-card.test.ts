import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkspaceChangesCard } from '../../web/src/components/WorkspaceChangesCard';

const { renderToStaticMarkup } = createRequire(new URL('../../web/package.json', import.meta.url))('react-dom/server');

const changes = {
  recordId: 'change_attempt_1', coverage: 'partial' as const, missingReasons: ['shell_unobserved'],
  totalFiles: 3, recordedAt: '2026-10-24T00:00:00.000Z',
  files: [
    { path: 'out/deck.pptx', added: 0, deleted: 0 },
    { path: '.scratch/png/render.png', added: 0, deleted: 0, scratch: true },
    { path: 'docs/notes.md', added: 0, deleted: 0 },
  ],
};

describe('workspace change observation card', () => {
  it('separates delivered, unregistered and scratch files with the coverage reason', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangesCard, {
      changes, delivered: ['out/deck.pptx'],
    }));
    expect(html).toContain('本轮改动');
    expect(html).toContain('out/deck.pptx');
    expect(html).toContain('临时');
    expect(html).toContain('未登记');
    expect(html).toContain('改动记录范围有限（不影响任务完成状态）');
    expect(html).toContain('通过 Shell 写入的文件无法由文件观察通道完整核对。');
  });

  it('does not label in-place observed files as undelivered when no publication receipt exists', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangesCard, {
      changes: { ...changes, missingReasons: ['filesystem_scope_limited'] },
      delivered: [],
    }));
    expect(html).not.toContain('未交付');
    expect(html).not.toContain('未登记');
    expect(html).toContain('当前 Workspace 不是 Git 仓库，只核对了授权范围内的文件。');
  });

  it('reports a complete observation without reasons', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangesCard, {
      changes: { ...changes, coverage: 'complete', missingReasons: [], totalFiles: 1,
        files: [{ path: 'out/deck.pptx', added: 0, deleted: 0 }] },
      delivered: ['out/deck.pptx'],
    }));
    expect(html).toContain('本轮改动已完整记录');
    expect(html).not.toContain('未登记');
  });
});
