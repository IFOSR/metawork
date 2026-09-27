import type { HttpClient } from './api/http';
import type { WorkspaceSummary } from './api/session-types';

export function createNavigationGuard(readGeneration: () => string) {
  const generation = readGeneration();
  let disposed = false;
  return {
    current: () => !disposed && generation === readGeneration(),
    dispose: () => { disposed = true; },
  };
}

export function canLoadDirectoryPage(
  loaded: { workspaceId: string; query: string } | null,
  workspaceId: string, query: string,
): boolean {
  return loaded?.workspaceId === workspaceId && loaded.query === query;
}

export async function loadStartupWorkspace(
  http: Pick<HttpClient, 'selectWorkspace' | 'getConversations'>,
  catalog: { activeWorkspaceId: string | null; workspaces: WorkspaceSummary[] },
  workspaceHint?: string | null,
) {
  if (!catalog.activeWorkspaceId && workspaceHint) {
    const selected = await loadWorkspaceSelection(http, workspaceHint).catch(() => null);
    if (selected) return {
      activeWorkspaceId: selected.activeWorkspaceId,
      workspaces: selected.workspace
        ? [...catalog.workspaces.filter(item => item.id !== selected.workspace!.id), selected.workspace]
        : catalog.workspaces,
      directory: {
        conversations: selected.conversations, nextCursor: selected.nextCursor,
        activeConversationId: selected.activeSessionId,
      },
    };
  }
  return {
    ...catalog,
    directory: catalog.activeWorkspaceId ? await http.getConversations(catalog.activeWorkspaceId) : null,
  };
}

export async function loadWorkspaceSelection(
  http: Pick<HttpClient, 'selectWorkspace' | 'getConversations'>,
  path: string,
) {
  const result = await http.selectWorkspace(path);
  if (result.selection.status !== 'accepted' || !result.activeWorkspaceId) {
    throw new Error(result.selection.status === 'failed'
      ? result.selection.reason : 'workspace_identity_missing');
  }
  const selection = result.selection;
  // Only old Servers need the extra request; current selection owns its page.
  const page = selection.conversations
    ? { conversations: selection.conversations, nextCursor: selection.nextCursor ?? null }
    : await http.getConversations(result.activeWorkspaceId);
  return {
    activeWorkspaceId: result.activeWorkspaceId, activeSessionId: result.activeSessionId,
    workspace: selection.workspace, ...page,
  };
}
