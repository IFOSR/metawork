import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Web workspace shell', () => {
  it('renders session navigation, dual views, and one shared composer', async () => {
    const [app, shell, sidebar, header, composer, styles] = await Promise.all([
      readFile(new URL('App.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceShell.tsx', root), 'utf8'),
      readFile(new URL('components/SessionSidebar.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceHeader.tsx', root), 'utf8'),
      readFile(new URL('components/Composer.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    expect(shell).toContain('<SessionSidebar');
    expect(shell).toContain('<WorkspaceHeader');
    expect(shell).toContain('<Composer');
    expect(sidebar).toContain('新建会话');
    expect(sidebar).toContain('搜索会话');
    expect(sidebar).toContain('继续此会话');
    expect(header).toContain('对话');
    expect(header).toContain('轨迹');
    expect(composer).toContain('<textarea');
    expect(app).toContain('activeSessionId');
    expect(app).toContain('browsedSessionId');
    expect(styles).toContain('@media (max-width: 860px)');
    expect(styles).toContain('.workspace-sidebar');
  });
});
