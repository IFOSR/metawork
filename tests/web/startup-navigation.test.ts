import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as requests from '../../web/src/navigation-requests.js';
import { NavigationDirectoryChanges } from '../../web/src/navigation-directory-state.js';
import { selectInitialSessionId } from '../../web/src/session-selection.js';
import { isCurrentConversationRecordRequest, retainLiveTurnForConversation } from '../../web/src/conversation-live-turn.js';
import { mergeNewestHistoryPage } from '../../web/src/navigation-history-state.js';
import type { WebSessionMetadata } from '../../web/src/api/session-types.js';

const app = ts.createSourceFile('App.tsx',
  await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.ArrowFunction[] = [];
function collect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'useEffect'
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
    effects.push(node.arguments[0]);
  }
  ts.forEachChild(node, collect);
}
collect(app);

// Execute the real App effects, not a copy of their promise/guard logic.
// HTTP/WS and React state are controlled here; no browser renderer is required.
function runEffect(marker: string, scope: Record<string, unknown>): (() => void) | undefined {
  const effect = effects.find(item => item.getText(app).includes(marker));
  if (!effect) throw new Error(`App effect missing: ${marker}`);
  const { outputText } = ts.transpileModule(`(${effect.getText(app)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(scope), `return ${outputText.trim().replace(/;$/, '')}`)(
    ...Object.values(scope),
  )();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function row(id: string, title = id): WebSessionMetadata {
  return {
    id, title, workspaceId: 'workspace_a', createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z', active: false, archived: false, preview: title,
    activity: { state: 'idle', taskId: null, updatedAt: '2026-09-26T00:00:00Z' },
    workspace: null,
  };
}
const workspace = { id: 'workspace_a', canonicalPath: '/a' };
const config = { revisionId: 'revision_a' };
const firstPage = Array.from({ length: 50 }, (_, n) => row(`conversation_${n}`));
const page = (conversations: WebSessionMetadata[], nextCursor: string | null = null) => ({
  activeWorkspaceId: workspace.id, activeConversationId: null as string | null, conversations, nextCursor,
});
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setTimeout, clearTimeout,
  });
  const initial = deferred<ReturnType<typeof page>>();
  const catalog = deferred<{ activeWorkspaceId: string | null; workspaces: typeof workspace[] }>();
  const http = {
    getWorkspaces: vi.fn(() => catalog.promise),
    getConfig: vi.fn(async () => config),
    getAgentReadiness: vi.fn(async () => ({ agents: [] })),
    getConversations: vi.fn((_workspaceId: string, _query?: string) => initial.promise),
    attachConversation: vi.fn(async (sessionId: string, _workspaceId?: string) => ({ state: 'active', sessionId })),
    getConversation: vi.fn(async (sessionId: string) => ({
      version: 1, session: row(sessionId), turns: [], historyCursor: null,
    })),
    selectWorkspace: vi.fn(async () => ({
      selection: { status: 'accepted', workspace, conversations: [], nextCursor: null },
      activeWorkspaceId: workspace.id, activeSessionId: null,
    })),
  };
  const state: Record<string, unknown> = {
    workspaces: [], sessions: [], activeWorkspaceId: null, configurationRuntime: null,
    directoryCursor: null, selectedRecord: null,
  };
  const ref = <T>(current: T) => ({ current });
  let ws!: {
    onWorkspaceDirectory: (id: string, active: null, rows: WebSessionMetadata[], cursor: string | null) => void;
    onHello: (id: string | null) => void;
    onActiveSessionChanged: (id: string) => void;
  };
  const scope = {
    ...requests, NavigationDirectoryChanges, selectInitialSessionId,
    isCurrentConversationRecordRequest, mergeNewestHistoryPage, retainLiveTurnForConversation,
    authenticated: true, startupLaunchSuggestion: null as { workspaceHint: string } | null,
    activeWorkspaceId: null as string | null, search: '',
    httpRef: ref<unknown>(null), wsRef: ref<unknown>(null),
    activeConversationRef: ref<string | null>(null), activeWorkspaceRef: ref<string | null>(null),
    startupLaunchAppliedRef: ref(false),
    browsedConversationRef: ref<string | null>(null), liveTurnRef: ref(null),
    loadRecordRef: ref<unknown>(null), recordRequestRef: ref(0), conversationRequestRef: ref(0),
    workspaceSwitchRef: ref(false), workspaceSwitchRequestRef: ref(0),
    conversationNavigationRef: ref({ generation: 0, target: null }),
    searchRef: ref(''), directoryLoadedRef: ref<{ workspaceId: string; query: string } | null>(null),
    directoryChangesRef: ref(new NavigationDirectoryChanges()), readinessFocusRefreshRef: ref(false),
    HttpClient: class { constructor() { return http; } },
    WsClient: class {
      constructor(callbacks: typeof ws) { ws = callbacks; }
      connect() {}
      close() {}
    },
  };
  const setters = Object.fromEntries([
    'workspaces', 'sessions', 'activeWorkspaceId', 'configurationRuntime', 'directoryCursor',
    'selectedRecord', 'activeSessionId', 'browsedSessionId', 'activationNotice',
    'agentReadiness', 'connected', 'authenticated', 'authError',
    'liveTurn', 'previewState', 'executionDetail',
  ].map(key => [`set${key[0]!.toUpperCase()}${key.slice(1)}`, (value: unknown) => {
    state[key] = typeof value === 'function' ? value(state[key]) : value;
    if (key === 'activeWorkspaceId') scope.activeWorkspaceId = state[key] as string | null;
  }]));
  function run(marker: string) {
    const cleanup = runEffect(marker, { ...scope, ...setters });
    if (cleanup) cleanups.push(cleanup);
    return cleanup;
  }
  return {
    http, state, scope, initial, catalog,
    start: () => run('new WsClient'),
    directoryEffect: () => run('const requestedWorkspaceId'),
    selectFromSocket(rows: WebSessionMetadata[] = firstPage, cursor: string | null = 'initial_more') {
      ws.onWorkspaceDirectory(workspace.id, null, rows, cursor);
    },
    hello: (id: string | null) => ws.onHello(id),
    activate: (id: string) => ws.onActiveSessionChanged(id),
    search(query: string) {
      scope.search = scope.searchRef.current = query;
      return run('const requestedWorkspaceId');
    },
  };
}

describe('App startup navigation effects', () => {
  it('ignores a deferred search result after clearing back to the cached unfiltered page', async () => {
    const f = fixture();
    f.start();
    const rows = [row('conversation_1')];
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    f.initial.resolve(page(rows));
    await vi.advanceTimersByTimeAsync(0);
    const pendingSearch = deferred<ReturnType<typeof page>>();
    f.http.getConversations.mockReturnValueOnce(pendingSearch.promise);
    const cleanup = f.search('needle');
    await vi.advanceTimersByTimeAsync(180);
    cleanup?.();
    f.search('');
    pendingSearch.resolve(page([row('conversation_51', 'needle')], 'search_more'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.sessions).toEqual(rows);
    expect(f.state.directoryCursor).toBeNull();
    expect(f.scope.directoryLoadedRef.current).toEqual({ workspaceId: workspace.id, query: '' });
  });

  it('clears inaccessible cached rows when both authenticated effects execute with retained React state', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = f.scope.activeWorkspaceId = workspace.id;
    f.scope.browsedConversationRef.current = 'old_conversation';
    f.scope.directoryLoadedRef.current = { workspaceId: workspace.id, query: '' };
    f.state.sessions = [row('old_conversation')];
    f.start();
    f.directoryEffect();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.sessions).toEqual([]);
    expect(f.scope.directoryLoadedRef.current).toBeNull();
    expect(f.state.activeWorkspaceId).toBeNull();
  });

  it('does not reuse a consumed launch hint after the user selected another Workspace', async () => {
    const f = fixture();
    f.scope.startupLaunchSuggestion = { workspaceHint: '/original-launch' };
    const cleanup = f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.selectWorkspace).toHaveBeenCalledWith('/original-launch');
    expect(f.scope.startupLaunchAppliedRef.current).toBe(true);
    cleanup?.();
    f.http.selectWorkspace.mockClear();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.selectWorkspace).toHaveBeenCalledWith('/a');
    expect(f.http.selectWorkspace).not.toHaveBeenCalledWith('/original-launch');
  });

  it('does not overwrite a newer off-page socket activation with a delayed startup page', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.start();
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    f.activate('conversation_51');
    f.initial.resolve(page(firstPage));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.attachConversation).not.toHaveBeenCalled();
    expect(f.state.activeSessionId).toBe('conversation_51');
    expect(f.state.browsedSessionId).toBe('conversation_51');
    expect(f.state.selectedRecord).toMatchObject({ session: { id: 'conversation_51' } });
  });

  it.each(['before', 'after'])('coalesces the hello history read %s startup resolution', async timing => {
    const f = fixture();
    f.start();
    if (timing === 'before') f.hello('conversation_1');
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    f.initial.resolve({ ...page([row('conversation_1')]), activeConversationId: 'conversation_1' });
    await vi.advanceTimersByTimeAsync(0);
    if (timing === 'after') f.hello('conversation_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.getConversation.mock.calls).toEqual([['conversation_1']]);
  });

  it('restores the prior authorized Workspace and Conversation after Server restart and reauthentication', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.scope.browsedConversationRef.current = 'conversation_5';
    f.scope.activeConversationRef.current = 'conversation_5';
    f.http.selectWorkspace.mockResolvedValue({
      selection: { status: 'accepted', workspace, conversations: firstPage, nextCursor: null },
      activeWorkspaceId: workspace.id, activeSessionId: null,
    });
    f.start();
    f.hello(null);
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.selectWorkspace).toHaveBeenCalledWith('/a');
    expect(f.http.attachConversation).toHaveBeenCalledWith('conversation_5');
    expect(f.state.activeWorkspaceId).toBe(workspace.id);
    expect(f.state.activeSessionId).toBe('conversation_5');
    expect(f.state.browsedSessionId).toBe('conversation_5');
    expect(f.state.selectedRecord).toMatchObject({ session: { id: 'conversation_5' } });
  });

  it('restores a previously selected Conversation beyond the first directory page using one bounded record read', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.scope.browsedConversationRef.current = 'conversation_51';
    let attached = false;
    f.http.attachConversation.mockImplementation(async sessionId => {
      attached = true;
      return { state: 'active', sessionId };
    });
    f.http.getConversation.mockImplementation(async sessionId => {
      if (!attached) throw new Error('HTTP 404: history is only available after attach');
      return { version: 1, session: row(sessionId), turns: [], historyCursor: null };
    });
    f.http.selectWorkspace.mockResolvedValue({
      selection: { status: 'accepted', workspace, conversations: firstPage, nextCursor: 'more' },
      activeWorkspaceId: workspace.id, activeSessionId: null,
    });
    f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.attachConversation).toHaveBeenCalledWith('conversation_51', workspace.id);
    expect(f.http.getConversation.mock.calls).toEqual([['conversation_51']]);
    expect(f.state.browsedSessionId).toBe('conversation_51');
    expect(f.state.selectedRecord).toMatchObject({ session: { id: 'conversation_51' } });
    expect(f.state.sessions).toHaveLength(firstPage.length);
    expect(f.state.sessions).toEqual(expect.arrayContaining(firstPage));
  });

  it('does not attach a remembered off-page Conversation belonging to another Workspace', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.scope.browsedConversationRef.current = 'conversation_moved';
    f.http.attachConversation.mockResolvedValue({ state: 'activation_blocked', sessionId: 'conversation_moved' });
    f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.attachConversation).toHaveBeenCalledWith('conversation_moved', workspace.id);
    expect(f.http.getConversation).not.toHaveBeenCalled();
    expect(f.state.browsedSessionId).toBeNull();
    expect(f.state.selectedRecord).toBeNull();
  });

  it('does not restore an off-page Conversation after newer navigation wins', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = workspace.id;
    f.scope.browsedConversationRef.current = 'conversation_51';
    const pending = deferred<Awaited<ReturnType<typeof f.http.attachConversation>>>();
    f.http.attachConversation.mockReturnValueOnce(pending.promise);
    f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    f.scope.conversationNavigationRef.current.generation += 1;
    f.scope.browsedConversationRef.current = 'newer_conversation';
    pending.resolve({ state: 'active', sessionId: 'conversation_51' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.getConversation).not.toHaveBeenCalled();
    expect(f.scope.browsedConversationRef.current).toBe('newer_conversation');
  });

  it('does not restore inaccessible Workspace hints or leave their stale directory and content visible', async () => {
    const f = fixture();
    f.scope.activeWorkspaceRef.current = 'unavailable_workspace';
    f.scope.browsedConversationRef.current = 'old_conversation';
    f.scope.activeConversationRef.current = 'old_conversation';
    f.state.sessions = [row('old_conversation')];
    f.state.selectedRecord = { session: row('old_conversation'), turns: [] };
    f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.selectWorkspace).not.toHaveBeenCalled();
    expect(f.http.attachConversation).not.toHaveBeenCalled();
    expect(f.state.activeSessionId).toBeNull();
    expect(f.state.browsedSessionId).toBeNull();
    expect(f.state.selectedRecord).toBeNull();
    expect(f.state.sessions).toEqual([]);
  });

  it('does not apply a prior authentication lifetime record after cleanup', async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.http.getConversation>>>();
    f.http.getConversation.mockReturnValueOnce(pending.promise);
    const cleanup = f.start();
    f.hello('conversation_1');
    cleanup?.();
    pending.resolve({ version: 1, session: row('conversation_1'), turns: [], historyCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.selectedRecord).toBeNull();
  });

  it('does not overwrite a completed search with the delayed unfiltered startup page', async () => {
    const f = fixture();
    f.start();
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    f.selectFromSocket();
    const matching = row('conversation_51', 'needle');
    f.http.getConversations.mockResolvedValueOnce(page([matching], 'search_more'));
    f.search('needle');
    await vi.advanceTimersByTimeAsync(180);
    expect(f.state.sessions).toEqual([matching]);

    f.initial.resolve(page(firstPage, 'initial_more'));
    await vi.advanceTimersByTimeAsync(0);

    expect(f.state.sessions).toEqual([matching]);
    expect(f.state.directoryCursor).toBe('search_more');
    expect(f.scope.directoryLoadedRef.current).toEqual({ workspaceId: workspace.id, query: 'needle' });
    expect(f.state.configurationRuntime).toEqual(config);
    expect(f.state.workspaces).toEqual([workspace]);
  });

  it('preserves a newer directory generation even when its search is still empty', async () => {
    const f = fixture();
    f.start();
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    const newer = [...firstPage, row('new_conversation')];
    f.selectFromSocket(newer, 'newer_more');
    f.initial.resolve(page(firstPage, 'initial_more'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.sessions).toEqual(newer);
    expect(f.state.directoryCursor).toBe('newer_more');
  });

  it('still initializes the Workspace and fetches search when typing precedes initial selection', async () => {
    const f = fixture();
    f.start();
    f.search('needle');
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    f.initial.resolve(page(firstPage, 'initial_more'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.configurationRuntime).toEqual(config);
    expect(f.state.workspaces).toEqual([workspace]);
    expect(f.state.activeWorkspaceId).toBe(workspace.id);
    expect(f.scope.directoryLoadedRef.current).toBeNull();
    expect(f.state.directoryCursor).toBeNull();
    const matching = row('conversation_51', 'needle');
    f.http.getConversations.mockResolvedValueOnce(page([matching]));
    f.directoryEffect();
    await vi.advanceTimersByTimeAsync(180);
    expect(f.state.sessions).toEqual([matching]);
    expect(f.http.getConversations).toHaveBeenLastCalledWith(workspace.id, 'needle');
  });

  it('applies a launch hint only after authentication and reuses its page', async () => {
    const f = fixture();
    f.scope.startupLaunchSuggestion = { workspaceHint: '/a' };
    f.scope.authenticated = false;
    f.start();
    expect(f.http.getWorkspaces).not.toHaveBeenCalled();
    expect(f.http.selectWorkspace).not.toHaveBeenCalled();
    f.scope.authenticated = true;
    f.start();
    f.catalog.resolve({ activeWorkspaceId: null, workspaces: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.http.selectWorkspace).toHaveBeenCalledTimes(1);
    expect(f.http.selectWorkspace).toHaveBeenCalledWith('/a');
    expect(f.http.getConversations).not.toHaveBeenCalled();
    expect(f.state.activeWorkspaceId).toBe(workspace.id);
    expect(f.state.workspaces).toEqual([workspace]);
    f.directoryEffect();
    await vi.advanceTimersByTimeAsync(180);
    expect(f.http.getConversations).not.toHaveBeenCalled();
  });

  it('keeps mandatory initialization after navigation invalidates startup selection', async () => {
    const f = fixture();
    f.start();
    f.scope.workspaceSwitchRequestRef.current += 1;
    f.state.workspaces = [{ id: 'workspace_b', canonicalPath: '/b' }];
    f.scope.activeWorkspaceId = 'workspace_b';
    f.state.activeWorkspaceId = 'workspace_b';
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.configurationRuntime).toEqual(config);
    expect(f.state.workspaces).toEqual([workspace, { id: 'workspace_b', canonicalPath: '/b' }]);
    expect(f.state.activeWorkspaceId).toBe('workspace_b');
    expect(f.http.getConversations).not.toHaveBeenCalled();
  });

  it('does not initialize or navigate after effect cleanup', async () => {
    const f = fixture();
    const cleanup = f.start();
    cleanup?.();
    f.catalog.resolve({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state.configurationRuntime).toBeNull();
    expect(f.state.workspaces).toEqual([]);
    expect(f.http.getConversations).not.toHaveBeenCalled();
  });
});
