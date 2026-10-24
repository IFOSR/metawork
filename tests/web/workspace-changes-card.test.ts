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
  it('separates delivered, undelivered and scratch files with the coverage reason', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangesCard, {
      changes, delivered: ['out/deck.pptx'],
    }));
    expect(html).toContain('本轮改动');
    expect(html).toContain('out/deck.pptx');
    expect(html).toContain('临时');
    expect(html).toContain('未交付');
    expect(html).toContain('记录不完整：仅覆盖可观察到的改动');
    expect(html).toContain('shell_unobserved');
  });

  it('reports a complete observation without reasons', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangesCard, {
      changes: { ...changes, coverage: 'complete', missingReasons: [], totalFiles: 1,
        files: [{ path: 'out/deck.pptx', added: 0, deleted: 0 }] },
      delivered: ['out/deck.pptx'],
    }));
    expect(html).toContain('本轮改动已完整记录');
    expect(html).not.toContain('未交付');
  });
});
