import { describe, expect, it, vi } from 'vitest';
import { loadWorkspaceSelection, loadStartupWorkspace, canLoadDirectoryPage, createNavigationGuard } from '../../web/src/navigation-requests.js';

describe('Workspace navigation request budget', () => {
  it('discards a delayed startup result after a newer Workspace selection', async () => {
    let generation = 0;
    let selected = 'a';
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const guard = createNavigationGuard(() => String(generation));
    const startup = pending.then(() => { if (guard.current()) selected = 'stale'; });
    generation += 1;
    selected = 'b';
    finish();
    await startup;
    expect(selected).toBe('b');
  });

  it('invalidates startup continuations after effect cleanup even without new navigation', () => {
    const guard = createNavigationGuard(() => 'same');
    expect(guard.current()).toBe(true);
    guard.dispose();
    expect(guard.current()).toBe(false);
  });

  it('reuses the authoritative launch selection page without refreshing Workspace or directory', async () => {
    const http = {
      selectWorkspace: vi.fn(async () => ({
        selection: { status: 'accepted', workspace: { id: 'workspace_a' }, conversations: [], nextCursor: 'more' },
        activeWorkspaceId: 'workspace_a', activeSessionId: null,
      })),
      getWorkspaces: vi.fn(() => { throw new Error('redundant workspaces'); }),
      getConversations: vi.fn(() => { throw new Error('redundant directory'); }),
    };
    const result = await loadStartupWorkspace(http as never, { activeWorkspaceId: null, workspaces: [] }, '/a');
    expect(result.directory).toEqual({ conversations: [], nextCursor: 'more', activeConversationId: null });
    expect(result.workspaces).toEqual([{ id: 'workspace_a' }]);
    expect(http.getConversations).not.toHaveBeenCalled();
    expect(http.getWorkspaces).not.toHaveBeenCalled();
  });

  it('does not paginate using the previous search or Workspace cursor', () => {
    expect(canLoadDirectoryPage({ workspaceId: 'a', query: '' }, 'a', 'weather')).toBe(false);
    expect(canLoadDirectoryPage({ workspaceId: 'a', query: '' }, 'b', '')).toBe(false);
    expect(canLoadDirectoryPage({ workspaceId: 'a', query: 'weather' }, 'a', 'weather')).toBe(true);
    expect(canLoadDirectoryPage(null, 'a', '')).toBe(false);
  });

  it('uses the selection response and performs no follow-up GET requests', async () => {
    const workspace = { id: 'workspace_a', canonicalPath: '/a' };
    const http = {
      selectWorkspace: vi.fn(async () => ({
        selection: { status: 'accepted', workspace, conversations: [], nextCursor: 'next' },
        activeWorkspaceId: 'workspace_a', activeSessionId: null,
      })),
      getWorkspaces: vi.fn(() => { throw new Error('redundant workspace fetch'); }),
      getConversations: vi.fn(() => { throw new Error('redundant directory fetch'); }),
    };
    expect(await loadWorkspaceSelection(http as never, '/a')).toMatchObject({
      workspace, conversations: [], nextCursor: 'next', activeWorkspaceId: 'workspace_a',
    });
    expect(http.selectWorkspace).toHaveBeenCalledTimes(1);
    expect(http.getWorkspaces).not.toHaveBeenCalled();
    expect(http.getConversations).not.toHaveBeenCalled();
  });

  it('does not query a directory after failed selection', async () => {
    const getConversations = vi.fn();
    await expect(loadWorkspaceSelection({
      selectWorkspace: async () => ({ selection: { status: 'failed', reason: 'directory_rebuilding' } }),
      getConversations,
    } as never, '/a')).rejects.toThrow('directory_rebuilding');
    expect(getConversations).not.toHaveBeenCalled();
  });
});
