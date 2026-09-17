import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '../../web/src/api/session-types';
import { WorkspaceSelector } from '../../web/src/components/WorkspaceSelector';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

const workspaces: WorkspaceSummary[] = [
  {
    id: 'workspace-a',
    accountId: 'local-default',
    displayName: 'Workspace A',
    canonicalPath: '/projects/a',
    availability: 'available',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    createdByPrincipal: 'local-user',
    archived: false,
  },
];

describe('WorkspaceSelector', () => {
  it.each([null, 'stale-workspace-id'])(
    'shows a placeholder instead of implying the first Workspace is active for %s',
    activeWorkspaceId => {
      const html = renderToStaticMarkup(createElement(WorkspaceSelector, {
        workspaces,
        activeWorkspaceId,
        onSelect: () => undefined,
        onCreateWorkspace: () => undefined,
      }));

      expect(html).toContain('请选择 Workspace');
      expect(html).toContain('点击添加按钮选择本机目录');
      expect(html).not.toContain('title="/projects/a"');
    },
  );
});
