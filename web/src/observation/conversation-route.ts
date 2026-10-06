export interface ConversationRoute {
  workspaceId: string;
  conversationId: string | null;
  turnId?: string;
  taskId?: string;
  artifactId?: string;
}

/** URL identities are navigation hints; every resource still passes Server authorization. */
export function readConversationRoute(hash = location.hash): ConversationRoute | null {
  if (hash.length > 2048) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const id = (key: string) => {
    const value = params.get(key);
    return value && /^[\w.:-]{1,256}$/u.test(value) ? value : null;
  };
  const workspaceId = id('workspace');
  if (!workspaceId) return null;
  return { workspaceId, conversationId: id('conversation'),
    ...(id('turn') ? { turnId: id('turn')! } : {}),
    ...(id('task') ? { taskId: id('task')! } : {}),
    ...(id('artifact') ? { artifactId: id('artifact')! } : {}) };
}

export function writeConversationRoute(route: ConversationRoute, replace = false): void {
  const params = new URLSearchParams({ workspace: route.workspaceId });
  if (route.conversationId) params.set('conversation', route.conversationId);
  if (route.turnId) params.set('turn', route.turnId);
  if (route.taskId) params.set('task', route.taskId);
  if (route.artifactId) params.set('artifact', route.artifactId);
  const hash = `#${params}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  void desktopBridge()?.setRoute(hash).catch(reportPersistenceError);
}
import { desktopBridge, reportPersistenceError } from '../platform/services';
