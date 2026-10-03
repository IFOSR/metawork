import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HttpClient } from '../api/http';
import type { ArtifactProjection, AttachmentMetadata, ConversationWorkspaceProjection, ConversationTurnProjection, WebSessionActivationResult, WebSessionMetadata, WorkspaceSummary } from '../api/session-types';
import type { AgentReadiness, ConfigurationRuntimeState } from '../api/types';
import { WsClient } from '../api/ws';
import { establishWebSession, exchangeWebCredential, loginWithPassword, resolveWebLaunchSuggestion, type WebLaunchSuggestion } from '../auth';
import { type ConversationViewportMemory } from './ObservedConversationView';
import { useConversationWindow, useConversationActivity, useConversationTurn } from './use-conversation';
import { turnProjection } from './turn-projection';
import { selectInitialSessionId } from '../session-selection';
import { type PreviewDrawerState } from '../components/ArtifactPreviewDrawer';
import type { WorkspaceTab } from '../components/WorkspaceHeader';
import { useThemePreference } from '../theme';
import { requiredAgentBlock } from '../agent-readiness';
import { evaluateAttachmentBudget } from '../attachment-limits';
import { canLoadDirectoryPage, createNavigationGuard, loadStartupWorkspace, loadWorkspaceSelection } from '../navigation-requests';
import { NavigationDirectoryChanges } from '../navigation-directory-state';
import { readConversationRoute, writeConversationRoute, type ConversationRoute } from './conversation-route';
import { ComposerStore } from './composer-store';

let startupAuthentication: ReturnType<typeof establishWebSession> | null = null;
let startupLaunchSuggestionPromise: Promise<WebLaunchSuggestion | null> | null = null;

export function useWorkspaceController() {
  const [themePreference, setThemePreference] = useThemePreference();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [startupLaunchSuggestion, setStartupLaunchSuggestion] = useState<WebLaunchSuggestion | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WebSessionMetadata[]>([]);
  const [directoryCursor, setDirectoryCursor] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [browsedSessionId, setBrowsedSessionId] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<{ id: string; title: string; workspaceId: string | null } | null>(null);
  const directoryChangesRef = useRef(new NavigationDirectoryChanges());
  const [tab, setTab] = useState<WorkspaceTab>('conversation');
  const [selectedTrajectoryTurnId, setSelectedTrajectoryTurnId] = useState<string | null>(null);
  const [selectedBillingTurnId, setSelectedBillingTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [route, setRoute] = useState<ConversationRoute | null>(() => readConversationRoute());
  const [search, setSearch] = useState('');
  const searchRef = useRef(search);
  searchRef.current = search;
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceCreatorOpen, setWorkspaceCreatorOpen] = useState(false);
  const [configurationRuntime, setConfigurationRuntime] = useState<ConfigurationRuntimeState | null>(null);
  const [agentReadiness, setAgentReadiness] = useState<AgentReadiness[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMetadata[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewDrawerState>({ status: 'closed' });
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [executionDetail, setExecutionDetail] = useState<{
    subtaskId: string;
    subtaskTitle: string;
    turnId: string;
    turn?: ConversationTurnProjection;
  } | null>(null);
  const httpRef = useRef<HttpClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const activeWorkspaceRef = useRef<string | null>(null);
  const browsedConversationRef = useRef<string | null>(null);
  const conversationRequestRef = useRef(0);
  const recordRequestRef = useRef(0);
  const workspaceSwitchRef = useRef(false);
  const workspaceSwitchRequestRef = useRef(0);
  const directoryLoadedRef = useRef<{ workspaceId: string; query: string } | null>(null);
  const startupLaunchAppliedRef = useRef(false);
  const conversationNavigationRef = useRef<{ generation: number; target: string | null }>({
    generation: 0, target: null,
  });
  const pendingInputsRef = useRef(new Map<string, {
    conversationId: string;
    rejected?: boolean;
    draft: string;
    attachments: AttachmentMetadata[];
  }>());
  const [, setPendingInputRevision] = useState(0);
  const readinessFocusRefreshRef = useRef(false);
  const [observationClient, setObservationClient] = useState<WsClient>();
  const viewportMemory = useRef<ConversationViewportMemory>({ anchors: new Map(), heights: new Map() });
  const drafts = useRef(new ComposerStore());
  const draftOwner = useRef<string | null>(null);
  const draftValue = useRef({ draft, attachments: pendingAttachments });
  draftValue.current = { draft, attachments: pendingAttachments };
  const observedId = browsedSessionId ?? activeSessionId ?? '';
  const observedWindow = useConversationWindow(observationClient?.conversations, observedId);
  const observedActivity = useConversationActivity(observationClient?.conversations, observedId);
  const latestObservedTurn = useConversationTurn(observationClient?.conversations, observedId, observedWindow.ids.at(-1) ?? '');
  const trajectoryObservedTurn = useConversationTurn(observationClient?.conversations, observedId, selectedTrajectoryTurnId ?? '');
  const billingObservedTurn = useConversationTurn(observationClient?.conversations, observedId, selectedBillingTurnId ?? '');
  useLayoutEffect(() => {
    draftOwner.current = observedId;
    const saved = drafts.current.get(observedId);
    setDraft(saved?.draft ?? ''); setPendingAttachments(saved?.attachments ?? []); setUploadError(null);
  }, [observedId]);
  const openTrajectory = useCallback((turnId: string) => { setSelectedTrajectoryTurnId(turnId); setTab('trajectory'); }, []);
  const openBilling = useCallback((turnId: string) => { setSelectedBillingTurnId(turnId); setTab('billing'); }, []);
  useEffect(() => observationClient?.conversations.onRevoked(id => {
    drafts.current.delete(id); viewportMemory.current.anchors.delete(id);
    for (const key of viewportMemory.current.heights.keys()) if (key.startsWith(`${id}\0`)) viewportMemory.current.heights.delete(key);
    for (const [key, input] of pendingInputsRef.current) if (input.conversationId === id) pendingInputsRef.current.delete(key);
    if (draftOwner.current === id) {
      draftOwner.current = null; draftValue.current = { draft: '', attachments: [] };
      setDraft(''); setPendingAttachments([]); setSelectedRecord(null);
      setSelectedTrajectoryTurnId(null); setSelectedBillingTurnId(null); setExecutionDetail(null);
      setPreviewState({ status: 'closed' }); ++recordRequestRef.current;
    }
  }), [observationClient]);
  useEffect(() => {
    if (!authenticated || !observationClient || !observedId) return;
    return observationClient.observations.follow(observedId);
  }, [authenticated, observationClient, observedId]);
  useEffect(() => {
    let active = true;
    startupAuthentication ??= establishWebSession();
    startupLaunchSuggestionPromise ??= resolveWebLaunchSuggestion().catch(() => null);
    void Promise.all([startupAuthentication, startupLaunchSuggestionPromise])
      .then(([session, suggestion]) => {
        if (!active) return;
        setStartupLaunchSuggestion(suggestion);
        setAuthenticated(Boolean(session));
      })
      .catch(error => {
        if (!active) return;
        setAuthError((error as Error).message);
        setAuthenticated(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const startupLifetime = createNavigationGuard(() => 'mounted');
    const previousSelection = {
      workspaceId: readConversationRoute()?.workspaceId ?? activeWorkspaceRef.current,
      conversationId: readConversationRoute()?.conversationId ?? browsedConversationRef.current,
    };
    const launchSuggestion = startupLaunchAppliedRef.current ? null : startupLaunchSuggestion;
    let socketSelectionGeneration = 0;
    const handleUnauthorized = () => {
      if (!startupLifetime.current()) return;
      setAuthenticated(false);
      setConnected(false);
      setAuthError('Web 会话已失效。请重新启动 Web 或输入 --no-open 显示的 token。');
    };
    const http = new HttpClient(handleUnauthorized);
    httpRef.current = http;
    const loadRecord = (sessionId: string, _reuse = false) => {
      if (browsedConversationRef.current !== sessionId) return;
      const request = ++recordRequestRef.current;
      void http.getConversationMetadata(sessionId).then(metadata => {
        if (startupLifetime.current() && request === recordRequestRef.current && browsedConversationRef.current === sessionId) {
          setSelectedRecord(metadata);
        }
      }).catch(() => undefined);
    };
    const ws = new WsClient({
      onHello: sessionId => {
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        if (sessionId) {
          if (!browsedConversationRef.current) {
            browsedConversationRef.current = sessionId;
            setBrowsedSessionId(sessionId);
          }
          loadRecord(sessionId, true);
        }
      },
      onSessionCatalog: (sessionId, nextSessions, nextCursor) => {
        if (workspaceSwitchRef.current || searchRef.current) return;
        ++conversationRequestRef.current;
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
        setDirectoryCursor(nextCursor ?? null);
        if (
          browsedConversationRef.current === sessionId
          && nextSessions.some(session => session.id === sessionId)
        ) {
          loadRecord(sessionId);
        }
      },
      onWorkspaceDirectory: (workspaceId, sessionId, nextSessions, nextCursor) => {
        if (workspaceSwitchRef.current) return;
        if (workspaceId === activeWorkspaceRef.current && searchRef.current) return;
        ++conversationRequestRef.current;
        activeWorkspaceRef.current = workspaceId;
        setActiveWorkspaceId(workspaceId);
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
        setDirectoryCursor(nextCursor ?? null);
        const nextBrowsedSessionId = (
          browsedConversationRef.current
          && nextSessions.some(session => session.id === browsedConversationRef.current)
        )
          ? browsedConversationRef.current
          : sessionId && nextSessions.some(session => session.id === sessionId)
            ? sessionId
            : null;
        browsedConversationRef.current = nextBrowsedSessionId;
        setBrowsedSessionId(nextBrowsedSessionId);
        setSelectedRecord(current => (
          current && nextSessions.some(session => session.id === current.id)
            ? current
            : null
        ));
      },
      onWorkspaceConversationChanged: event => {
        const changes = directoryChangesRef.current;
        changes.observe(event);
        if (event.workspaceId !== activeWorkspaceRef.current) return;
        const observed = changes.sequence - 1;
        setSessions(current => changes.merge(current, event.workspaceId, searchRef.current, observed));
        setSelectedRecord(current => current?.id === event.conversationId
          && current.workspaceId === event.workspaceId && event.changes
          ? { ...current, ...event.changes } : current);
      },
      onActiveSessionChanged: sessionId => {
        const navigation = conversationNavigationRef.current;
        if (workspaceSwitchRef.current || (navigation.target
          && navigation.target !== sessionId && navigation.target !== 'new')) return;
        if (!navigation.target) socketSelectionGeneration += 1;
        activeConversationRef.current = sessionId;
        browsedConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setBrowsedSessionId(sessionId);
        setActivationNotice(null);
        // 切换会话后旧会话的预览与执行详情不得残留。
        setPreviewState({ status: 'closed' });
        setExecutionDetail(null);
        if (!navigation.target) loadRecord(sessionId);
      },
      onWorkspaceChanged: (
        sessionId: string,
        workspace: ConversationWorkspaceProjection | null,
      ) => {
        setSessions(current => current.map(session => (
          session.id === sessionId ? { ...session, workspace } : session
        )));
      },
      onConfigurationRuntimeState: state => setConfigurationRuntime(state),
      onAgentReadinessState: agents => setAgentReadiness(agents),
      onCommandResult: result => {
        if (result.targetConversationId !== browsedConversationRef.current) return;
        setActivationNotice(result.status === 'completed' ? '操作已处理。' : `操作未完成：${result.reason ?? '请刷新状态后重试。'}`);
      },
      onReceipt: receipt => {
        const pending = pendingInputsRef.current.get(receipt.requestId);
        if (receipt.status !== 'rejected') {
          pendingInputsRef.current.delete(receipt.requestId);
          if (pending?.conversationId === browsedConversationRef.current) {
            setActivationNotice(current => current === '正在确认发送状态…' ? null : current);
          }
        }
        setPendingInputRevision(value => value + 1);
      },
      onOutput: lines => {
        if (lines.some(line => line.startsWith('错误:'))) {
          setActivationNotice(lines.join('\n'));
        }
      },
      onError: (message, detail) => {
        const pending = detail?.requestId
          ? pendingInputsRef.current.get(detail.requestId)
          : undefined;
        if (pending && detail?.requestId && detail.admissionRejected) {
          pending.rejected = true;
          // A late rejection must never overwrite work typed after Send.
          if (!drafts.current.get(pending.conversationId)) {
            try {
              drafts.current.set(pending.conversationId, pending);
              pendingInputsRef.current.delete(detail.requestId);
              if (browsedConversationRef.current === pending.conversationId) {
                setDraft(pending.draft); setPendingAttachments(pending.attachments);
              }
            } catch { /* Keep the rejected input until a draft slot becomes available. */ }
          }
          setPendingInputRevision(value => value + 1);
        }
        setActivationNotice(`执行错误：${message}`);
      },
      onUnauthorized: handleUnauthorized,
      onStatusChange: connected => {
        if (startupLifetime.current()) setConnected(connected);
      },
    });
    wsRef.current = ws;
    setObservationClient(ws);
    ws.connect();
    void http.getAgentReadiness()
      .then(result => setAgentReadiness(result.agents))
      .catch(() => undefined);
    const handleReadinessFocus = () => {
      if (!readinessFocusRefreshRef.current) return;
      readinessFocusRefreshRef.current = false;
      void http.refreshAgentReadiness()
        .then(result => setAgentReadiness(result.agents))
        .catch(() => undefined);
    };
    window.addEventListener('focus', handleReadinessFocus);
    const startupGuard = createNavigationGuard(() => JSON.stringify([
      workspaceSwitchRequestRef.current, conversationNavigationRef.current.generation, socketSelectionGeneration,
    ]));
    const startupDirectoryGuard = createNavigationGuard(() => JSON.stringify([
      conversationRequestRef.current, searchRef.current,
    ]));
    const startupEvents = directoryChangesRef.current.sequence;
    void Promise.all([http.getWorkspaces(), http.getConfig()])
      .then(async ([workspaceCatalog, config]) => {
        if (!startupLifetime.current()) return;
        setConfigurationRuntime(config);
        setWorkspaces(current => [...new Map(
          [...workspaceCatalog.workspaces, ...current].map(workspace => [workspace.id, workspace]),
        ).values()]);
        if (!startupGuard.current()) {
          startupLaunchAppliedRef.current = true;
          return;
        }
        const applied = await loadStartupWorkspace(
          http,
          readConversationRoute() ? { ...workspaceCatalog, activeWorkspaceId: null } : workspaceCatalog,
          launchSuggestion?.workspaceHint
            ?? workspaceCatalog.workspaces.find(item => item.id === previousSelection.workspaceId)?.canonicalPath,
        );
        if (startupLifetime.current()) startupLaunchAppliedRef.current = true;
        if (!startupGuard.current()) return;
        const catalog = applied.directory;
        const requestedConversationId = launchSuggestion?.conversationId
          ?? (applied.activeWorkspaceId === previousSelection.workspaceId
            ? previousSelection.conversationId : null);
        const offPageRequest = Boolean(applied.activeWorkspaceId && requestedConversationId
          && !catalog?.conversations.some(session => session.id === requestedConversationId));
        let initialSessionId = (offPageRequest ? requestedConversationId : null) ?? selectInitialSessionId(
          catalog?.conversations ?? [],
          requestedConversationId,
          catalog?.activeConversationId ?? null,
        );
        let resolvedActiveSessionId = catalog?.activeConversationId ?? null;
        let requestedConversationUnavailable = false;
        if (offPageRequest && initialSessionId) {
          const metadata = await http.getConversationMetadata(initialSessionId).catch(() => null);
          if (!startupGuard.current()) return;
          if (metadata?.workspaceId !== applied.activeWorkspaceId) {
            initialSessionId = null;
            resolvedActiveSessionId = null;
            requestedConversationUnavailable = true;
            setActivationNotice('链接中的会话不可用，请从目录重新选择。');
          }
        }
        if (initialSessionId) resolvedActiveSessionId = initialSessionId;
        setWorkspaces(applied.workspaces);
        activeWorkspaceRef.current = applied.activeWorkspaceId;
        setActiveWorkspaceId(applied.activeWorkspaceId);
        // Startup owns an unfiltered page, never a newer search or directory response.
        if (!applied.activeWorkspaceId) {
          ++conversationRequestRef.current;
          directoryLoadedRef.current = null;
          setSessions([]);
          setDirectoryCursor(null);
        } else if (startupDirectoryGuard.current() && searchRef.current === '') {
          const rows = applied.activeWorkspaceId
            ? directoryChangesRef.current.merge(catalog?.conversations ?? [], applied.activeWorkspaceId, '', startupEvents)
            : [];
          setSessions(rows);
          setDirectoryCursor(catalog?.nextCursor ?? null);
          if (applied.activeWorkspaceId) directoryLoadedRef.current = {
            workspaceId: applied.activeWorkspaceId, query: '',
          };
        }
        // WebSocket 事件可能在本启动快照返回前就已建立活动会话。此时不得用陈旧目录覆盖它，
        // 焦点恢复必须遵守当前浏览目标。
        const liveSessionId = !requestedConversationId
          && catalog?.conversations.some(session => session.id === activeConversationRef.current)
          ? activeConversationRef.current : null;
        const activeInWorkspace = liveSessionId ?? (
          (initialSessionId !== null && initialSessionId === resolvedActiveSessionId
            || catalog?.conversations.some(session => session.id === resolvedActiveSessionId))
            ? resolvedActiveSessionId
            : null
        );
        const resolvedSessionId = requestedConversationUnavailable ? null : initialSessionId ?? activeInWorkspace;
        activeConversationRef.current = activeInWorkspace;
        setActiveSessionId(activeInWorkspace);
        const nextBrowsedSessionId = resolvedSessionId;
        browsedConversationRef.current = nextBrowsedSessionId;
        setBrowsedSessionId(nextBrowsedSessionId);
        setConfigurationRuntime(config);
        if (nextBrowsedSessionId) {
          if (applied.activeWorkspaceId) writeConversationRoute({ ...readConversationRoute(),
            workspaceId: applied.activeWorkspaceId, conversationId: nextBrowsedSessionId }, true);
          loadRecord(nextBrowsedSessionId, true);
        } else {
          ++recordRequestRef.current;
          setSelectedRecord(null);
        }
      })
      .catch(() => undefined);
    return () => {
      startupLifetime.dispose();
      startupGuard.dispose();
      startupDirectoryGuard.dispose();
      window.removeEventListener('focus', handleReadinessFocus);
      ws.close();
      drafts.current.clear(); viewportMemory.current.anchors.clear(); viewportMemory.current.heights.clear();
      pendingInputsRef.current.clear();
      setPendingInputRevision(value => value + 1);
      draftOwner.current = null; draftValue.current = { draft: '', attachments: [] };
      setDraft(''); setPendingAttachments([]); setPreviewState({ status: 'closed' }); setExecutionDetail(null);
    };
  }, [authenticated, startupLaunchSuggestion]);
  useEffect(() => {
    const restore = () => {
      const target = readConversationRoute(); const http = httpRef.current;
      if (!authenticated || !target || !http) return;
      const generation = ++conversationNavigationRef.current.generation;
      ++workspaceSwitchRequestRef.current; ++recordRequestRef.current;
      const scope = observationClient?.conversations.currentGeneration();
      void Promise.all([http.getConversations(target.workspaceId), target.conversationId
        ? http.getConversationMetadata(target.conversationId) : Promise.resolve(null)]).then(([directory, metadata]) => {
        if (generation !== conversationNavigationRef.current.generation || scope !== observationClient?.conversations.currentGeneration()) return;
        if (target.conversationId && metadata?.workspaceId !== target.workspaceId) throw new Error('conversation_workspace_mismatch');
        activeWorkspaceRef.current = target.workspaceId; setActiveWorkspaceId(target.workspaceId);
        setSessions(directory.conversations); setDirectoryCursor(directory.nextCursor ?? null); setSearch('');
        directoryLoadedRef.current = { workspaceId: target.workspaceId, query: '' };
        browsedConversationRef.current = target.conversationId; activeConversationRef.current = target.conversationId;
        setBrowsedSessionId(target.conversationId); setActiveSessionId(target.conversationId); setSelectedRecord(metadata);
        setRoute(target); setTab('conversation'); setActivationNotice(null);
        setPreviewState({ status: 'closed' }); setExecutionDetail(null);
      }).catch(error => {
        if (generation === conversationNavigationRef.current.generation) setActivationNotice(`无法打开链接：${(error as Error).message}`);
      });
    };
    window.addEventListener('popstate', restore); window.addEventListener('hashchange', restore);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore); };
  }, [authenticated, observationClient]);
  useEffect(() => {
    if (!authenticated || !httpRef.current || !activeWorkspaceId) return;
    if (directoryLoadedRef.current?.workspaceId === activeWorkspaceId
      && directoryLoadedRef.current.query === search) return;
    const requestId = ++conversationRequestRef.current;
    const requestedWorkspaceId = activeWorkspaceId;
    let active = true;
    const timer = window.setTimeout(() => {
      const eventsAtRequest = directoryChangesRef.current.sequence;
      void httpRef.current?.getConversations(requestedWorkspaceId, search)
        .then(result => {
          if (
            !active || requestId !== conversationRequestRef.current
            || result.activeWorkspaceId !== requestedWorkspaceId
          ) {
            return;
          }
          setSessions(directoryChangesRef.current.merge(result.conversations, requestedWorkspaceId, search, eventsAtRequest));
          setDirectoryCursor(result.nextCursor ?? null);
          directoryLoadedRef.current = { workspaceId: requestedWorkspaceId, query: search };
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [authenticated, activeWorkspaceId, search]);
  useEffect(() => setSelectedTrajectoryTurnId(null), [activeWorkspaceId, browsedSessionId]);
  useEffect(() => setSelectedBillingTurnId(null), [activeWorkspaceId, browsedSessionId]);
  useEffect(() => {
    if (previewState.status === 'closed' && !executionDetail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPreviewState({ status: 'closed' });
        setPreviewCollapsed(false);
        setExecutionDetail(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewState.status, executionDetail]);
  const handleSelectWorkspace = (workspace: WorkspaceSummary) => {
    if (workspace.availability !== 'available') {
      setActivationNotice(`Workspace ${workspace.displayName} 当前不可用。`);
      return;
    }
    void handleSelectWorkspacePath(workspace.canonicalPath);
  };
  const handleCreateWorkspace = async (path: string): Promise<string | null> => {
    return handleSelectWorkspacePath(path);
  };
  const handleSelectWorkspacePath = async (workspacePath: string): Promise<string | null> => {
    const http = httpRef.current;
    if (!http) return 'Workspace 服务尚未就绪，请稍后重试。';
    if (workspaceSwitchRef.current) return '正在切换 Workspace，请稍后重试。';
    workspaceSwitchRef.current = true;
    conversationNavigationRef.current = {
      generation: conversationNavigationRef.current.generation + 1, target: null,
    };
    const switchRequestId = ++workspaceSwitchRequestRef.current;
    ++conversationRequestRef.current;
    ++recordRequestRef.current;
    setWorkspaceSwitching(true);
    setActivationNotice(null);
    const eventsAtRequest = directoryChangesRef.current.sequence;
    try {
      const result = await loadWorkspaceSelection(http, workspacePath);
      if (switchRequestId !== workspaceSwitchRequestRef.current) return null;
      const workspaceActiveSessionId = result.conversations.some(
        session => session.id === result.activeSessionId,
      )
        ? result.activeSessionId
        : null;
      if (result.workspace) {
        const workspace = result.workspace;
        setWorkspaces(current => [...current.filter(item => item.id !== workspace.id), workspace]);
      }
      directoryLoadedRef.current = { workspaceId: result.activeWorkspaceId, query: '' };
      activeWorkspaceRef.current = result.activeWorkspaceId;
      setSearch('');
      setDirectoryCursor(result.nextCursor ?? null);
      setActiveWorkspaceId(result.activeWorkspaceId);
      activeConversationRef.current = workspaceActiveSessionId;
      browsedConversationRef.current = workspaceActiveSessionId;
      setActiveSessionId(workspaceActiveSessionId);
      setSessions(directoryChangesRef.current.merge(result.conversations, result.activeWorkspaceId, '', eventsAtRequest));
      setBrowsedSessionId(workspaceActiveSessionId);
      setSelectedRecord(null);
      setPreviewState({ status: 'closed' });
      setExecutionDetail(null);
      setActivationNotice(null);
      writeConversationRoute({ workspaceId: result.activeWorkspaceId, conversationId: workspaceActiveSessionId });
      setRoute(null);
      return null;
    } catch (error) {
      const message = `Workspace 切换失败：${(error as Error).message}`;
      setActivationNotice(message);
      return message;
    } finally {
      if (switchRequestId === workspaceSwitchRequestRef.current) {
        workspaceSwitchRef.current = false;
        setWorkspaceSwitching(false);
      }
    }
  };
  const handleOpenArtifact = (artifact: ArtifactProjection) => {
    const http = httpRef.current;
    if (!http) return;
    const generation = observationClient?.conversations.currentGeneration();
    setPreviewCollapsed(false);
    setPreviewState({ status: 'loading', artifactId: artifact.artifactId });
    void http.getArtifactPreview(artifact.artifactId)
      .then(result => setPreviewState(current => (
        httpRef.current === http && generation === observationClient?.conversations.currentGeneration()
          && current.status === 'loading' && current.artifactId === artifact.artifactId
          ? {
            status: 'ready',
            artifact: result.artifact,
            content: result.content,
            ...(result.renderedHtml ? { renderedHtml: result.renderedHtml } : {}),
          }
          : current
      )))
      .catch(error => setPreviewState(current => (
        httpRef.current === http && generation === observationClient?.conversations.currentGeneration()
          && current.status === 'loading' && current.artifactId === artifact.artifactId
          ? { status: 'error', artifactId: artifact.artifactId, message: (error as Error).message }
          : current
      )));
  };
  useEffect(() => {
    if (!authenticated || !observationClient || !httpRef.current || !route?.artifactId || route.conversationId !== observedId) return;
    const artifactId = route.artifactId;
    const generation = observationClient.conversations.currentGeneration(); let active = true;
    setPreviewState({ status: 'loading', artifactId });
    void httpRef.current.getArtifactPreview(artifactId).then(result => {
      if (active && generation === observationClient.conversations.currentGeneration()) setPreviewState({ status: 'ready',
        artifact: result.artifact, content: result.content, ...(result.renderedHtml ? { renderedHtml: result.renderedHtml } : {}) });
    }).catch(error => {
      if (active && generation === observationClient.conversations.currentGeneration()) setPreviewState({ status: 'error', artifactId, message: (error as Error).message });
    });
    return () => { active = false; };
  }, [authenticated, observationClient, observedId, route]);
  const handleLoadMoreConversations = async () => {
    const http = httpRef.current;
    if (!http || !activeWorkspaceId || !directoryCursor || directoryLoading) return;
    if (!canLoadDirectoryPage(directoryLoadedRef.current, activeWorkspaceId, search)) return;
    const request = ++conversationRequestRef.current;
    const workspaceId = activeWorkspaceId;
    const eventsAtRequest = directoryChangesRef.current.sequence;
    setDirectoryLoading(true);
    try {
      let reset = false;
      const page = await http.getConversations(workspaceId, search, directoryCursor).catch(async error => {
        if (!(error as Error).message.includes('stale_directory_cursor')) throw error;
        reset = true;
        return http.getConversations(workspaceId, search);
      });
      if (request !== conversationRequestRef.current) return;
      setSessions(current => directoryChangesRef.current.merge(reset ? page.conversations : [
        ...current, ...page.conversations.filter(item => !current.some(existing => existing.id === item.id)),
      ], workspaceId, search, eventsAtRequest));
      setDirectoryCursor(page.nextCursor ?? null);
    } catch (error) {
      if (request === conversationRequestRef.current) setActivationNotice((error as Error).message);
    } finally {
      setDirectoryLoading(false);
    }
  };
  const handleSelectSession = (sessionId: string) => {
    if (workspaceSwitchRef.current) return;
    conversationNavigationRef.current = { generation: conversationNavigationRef.current.generation + 1, target: null };
    browsedConversationRef.current = sessionId;
    activeConversationRef.current = sessionId;
    setBrowsedSessionId(sessionId); setActiveSessionId(sessionId);
    setSelectedRecord(null); setActivationNotice(null);
    setPreviewState({ status: 'closed' }); setExecutionDetail(null);
    setRoute(null);
    if (activeWorkspaceRef.current) writeConversationRoute({ workspaceId: activeWorkspaceRef.current, conversationId: sessionId });
  };
  const handleNewSession = async () => {
    if (workspaceSwitchRef.current) return;
    const requiredBlock = requiredAgentBlock(agentReadiness);
    if (requiredBlock.blocked) {
      setActivationNotice(requiredBlock.message);
      return;
    }
    if (!httpRef.current || !activeWorkspaceId) {
      setActivationNotice('请先选择 Workspace，再新建会话。');
      return;
    }
    const generation = conversationNavigationRef.current.generation + 1;
    conversationNavigationRef.current = { generation, target: 'new' };
    const workspaceGeneration = workspaceSwitchRequestRef.current;
    try {
      const result = await httpRef.current.createConversation(activeWorkspaceId);
      if (generation !== conversationNavigationRef.current.generation
        || workspaceGeneration !== workspaceSwitchRequestRef.current) return;
      setSessions(current => [
        result.session.session, ...current.filter(item => item.id !== result.session.session.id),
      ]);
      browsedConversationRef.current = result.session.session.id;
      setBrowsedSessionId(result.session.session.id);
      setSelectedRecord(result.session.session);
      setRoute(null);
      writeConversationRoute({ workspaceId: activeWorkspaceId, conversationId: result.session.session.id });
      setActivationNotice(activationMessage(result.activation));
      if (result.activation.state === 'active') {
        activeConversationRef.current = result.session.session.id;
        setActiveSessionId(result.session.session.id);
        setPreviewState({ status: 'closed' });
        setExecutionDetail(null);
      }
    } catch (error) {
      const message = (error as Error).message;
      setActivationNotice(
        message.includes('required_agent_unavailable')
          ? `当前无法新建会话，请先安装${requiredAgentBlock(agentReadiness).agent?.displayName ?? '必需智能体'}。`
          : `新建会话失败：${message}`,
      );
    } finally {
      if (generation === conversationNavigationRef.current.generation) {
        conversationNavigationRef.current.target = null;
      }
    }
  };
  const handleRefreshAgentReadiness = () => {
    void httpRef.current?.refreshAgentReadiness()
      .then(result => setAgentReadiness(result.agents))
      .catch(error => setActivationNotice(`重新检测失败：${(error as Error).message}`));
  };
  const handleOpenAgentSettings = () => {
    readinessFocusRefreshRef.current = true;
    setSettingsOpen(true);
  };
  const handleDeleteSession = async (sessionId: string) => {
    if (!httpRef.current) return;
    try {
      await httpRef.current.deleteConversation(sessionId);
      setSessions(current => current.filter(session => session.id !== sessionId));
      if (browsedSessionId === sessionId) {
        browsedConversationRef.current = null;
        ++recordRequestRef.current;
        setBrowsedSessionId(null);
        setSelectedRecord(null);
      }
      setActivationNotice(null);
    } catch (error) {
      setActivationNotice(`删除失败：${(error as Error).message}`);
    }
  };
  const handleFilesSelected = async (files: File[]) => {
    const uploadTarget = browsedConversationRef.current;
    if (!httpRef.current || !uploadTarget) {
      setUploadError('当前没有活跃会话，无法上传附件。');
      return;
    }
    if (!drafts.current.canEdit(uploadTarget)) {
      setUploadError('已有 64 个未发送草稿，请先发送或清空其中一个。'); return;
    }
    const uploadGeneration = observationClient?.conversations.currentGeneration();
    setUploadError(null);
    // Track the selection locally: React state does not advance inside this
    // loop, so counting `pendingAttachments` here would miss every file added
    // by the current batch.
    const selection = pendingAttachments.map(attachment => ({
      name: attachment.name,
      size: attachment.size,
    }));
    for (const file of files) {
      const violation = evaluateAttachmentBudget([...selection, { name: file.name, size: file.size }]);
      if (violation) {
        setUploadError(violation.message);
        break;
      }
      try {
        const metadata = await httpRef.current.uploadAttachment(
          uploadTarget,
          file.name,
          file,
        );
        if (uploadGeneration !== observationClient?.conversations.currentGeneration()) return;
        selection.push({ name: metadata.name, size: metadata.size });
        const saved = drafts.current.get(uploadTarget) ?? { draft: '', attachments: [] };
        const updated = { ...saved, attachments: [...saved.attachments, metadata] };
        drafts.current.set(uploadTarget, updated);
        if (browsedConversationRef.current === uploadTarget) setPendingAttachments(updated.attachments);
      } catch (error) {
        setUploadError(`上传 ${file.name} 失败：${(error as Error).message}`);
      }
    }
  };
  const handleClearSessions = async () => {
    if (!httpRef.current) return;
    try {
      const result = await httpRef.current.clearConversations();
      setSessions(current => current.filter(session => session.id === activeSessionId));
      if (browsedSessionId && browsedSessionId !== activeSessionId) {
        browsedConversationRef.current = null;
        ++recordRequestRef.current;
        setBrowsedSessionId(null);
        setSelectedRecord(null);
      }
      setActivationNotice(result.deleted > 0 ? `已清空 ${result.deleted} 个历史会话。` : null);
    } catch (error) {
      setActivationNotice(`清空失败：${(error as Error).message}`);
    }
  };
  const handleAuth = async (token: string): Promise<boolean> => {
    try {
      const session = await exchangeWebCredential(token);
      setAuthError(session ? null : 'token 无效或已过期。');
      if (session) {
        setAuthenticated(true);
      }
      return Boolean(session);
    } catch (error) {
      setAuthError((error as Error).message);
      return false;
    }
  };
  const handleLogin = async (username: string, password: string): Promise<boolean> => {
    try {
      const ok = await loginWithPassword(username, password);
      setAuthError(ok ? null : '用户名或密码错误，或尝试次数过多，请稍后再试。');
      if (ok) {
        setAuthenticated(true);
      }
      return ok;
    } catch (error) {
      setAuthError((error as Error).message);
      return false;
    }
  };
  const handleDraftChange = (text: string) => {
    const id = browsedConversationRef.current; if (!id) return;
    try { drafts.current.set(id, { draft: text, attachments: pendingAttachments }); setDraft(text); }
    catch (error) { setActivationNotice((error as Error).message); }
  };
  const handleSend = (text: string, attachments: Array<{ attachmentId: string }>) => {
    if (pendingInputsRef.current.size >= 64) {
      setActivationNotice('有较多消息正在确认发送状态，请稍后再发。'); return;
    }
    const target = browsedConversationRef.current;
    const requestId = target ? wsRef.current?.sendCommand(target, text.trim().startsWith('/')
      ? { kind: 'slash_command', text }
      : { kind: 'user_message', text, attachments: (attachments ?? []).map(item => ({ ...item, kind: 'file' })) }) ?? null : null;
    if (!requestId) {
      setActivationNotice('WebSocket 尚未连接，消息仍保留在输入框中。');
      return;
    }
    pendingInputsRef.current.set(requestId, {
      conversationId: target!,
      draft: text,
      attachments: pendingAttachments,
    });
    drafts.current.delete(target!);
    setDraft('');
    setPendingAttachments([]);
    setActivationNotice('正在确认发送状态…');
    setPendingInputRevision(value => value + 1);
  };
  const handleRemoveAttachment = (attachmentId: string) => {
    const id = browsedConversationRef.current; if (!id) return;
    const saved = drafts.current.get(id) ?? { draft: '', attachments: [] };
    const updated = { ...saved, attachments: saved.attachments.filter(item => item.attachmentId !== attachmentId) };
    drafts.current.set(id, updated); setPendingAttachments(updated.attachments);
  };
  const failedInput = [...pendingInputsRef.current].find(([, input]) => input.rejected && input.conversationId === observedId);
  const handleRestoreFailedInput = () => {
    if (!failedInput) return;
    if (drafts.current.get(observedId)) {
      setActivationNotice('请先发送或清空当前草稿，再恢复发送失败的内容。'); return;
    }
    try {
      drafts.current.set(observedId, failedInput[1]);
      setDraft(failedInput[1].draft); setPendingAttachments(failedInput[1].attachments);
      pendingInputsRef.current.delete(failedInput[0]); setPendingInputRevision(value => value + 1);
    } catch (error) { setActivationNotice((error as Error).message); }
  };
  const handleCancelTurn = () => {
    const target = browsedConversationRef.current;
    const source = wsRef.current?.conversations;
    const turnId = target && source ? [...source.window(target).ids].reverse().find(id => source.turn(target, id)?.status === 'running') : null;
    if (target && source && !turnId) {
      const active = source.activity(target).tasks.filter(task => task.canCancel && task.phase !== 'queued');
      if (active.length === 1) {
        const task = active[0]!;
        setActivationNotice('已请求停止当前任务。');
        void wsRef.current?.control(target, { kind: 'cancel_task', taskId: task.taskId,
          expectedExecutionGeneration: task.executionGeneration }, () => undefined).then(result => {
          if (browsedConversationRef.current === target) setActivationNotice(result.status === 'completed'
            ? '停止请求已处理。' : `操作未完成：${result.reason ?? '请刷新状态后重试。'}`);
        }).catch(error => {
          if (browsedConversationRef.current === target) setActivationNotice((error as Error).message);
        });
        return;
      }
    }
    if (!target || !turnId || !wsRef.current?.sendCommand(target, { kind: 'cancel_turn', turnId })) {
      setActivationNotice('WebSocket 尚未连接，无法停止当前轮。');
      return;
    }
    setActivationNotice('已请求停止当前轮。');
  };
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  const activeConversationInWorkspace = activeSessionId
    && sessions.some(session => session.id === activeSessionId)
    ? activeSessionId
    : null;
  const selectedId = browsedSessionId ?? activeConversationInWorkspace;
  const selectedMetadata = sessions.find(session => session.id === selectedId)
    ?? selectedRecord;
  const latestTurn = latestObservedTurn ? turnProjection(latestObservedTurn) : null;
  const selectedTrajectoryTurn = trajectoryObservedTurn ? turnProjection(trajectoryObservedTurn) : latestTurn;
  const selectedBillingTurn = billingObservedTurn ? turnProjection(billingObservedTurn) : latestTurn;
  const running = observedActivity.tasks.some(task => task.canCancel) || latestTurn?.status === 'running';
  const requiredBlock = requiredAgentBlock(agentReadiness);
  const composerDisabled = !selectedId || !connected || requiredBlock.blocked;
  const composerBlockedReason = workspaceSwitching
    ? '正在切换 Workspace…'
    : !connected
        ? 'WebSocket 尚未连接，消息不会丢失。连接恢复后再发送。'
        : requiredBlock.blocked
          ? requiredBlock.message
        : activationNotice;
  const executionDetailTurn = executionDetail
    ? executionDetail.turn ?? (() => {
      const entity = observationClient?.conversations.turn(observedId, executionDetail.turnId);
      return entity ? turnProjection(entity) : null;
    })()
    : null;
  const executionDetailOpen = executionDetail !== null && executionDetailTurn !== null;
  return {
    themePreference, setThemePreference, authenticated, authError, connected,
    workspaces, activeWorkspaceId, sessions, directoryCursor, directoryLoading,
    activeSessionId, workspaceSwitching, tab, setTab, setSelectedTrajectoryTurnId,
    draft, route, search, setSearch, settingsOpen,
    setSettingsOpen, workspaceCreatorOpen, setWorkspaceCreatorOpen, configurationRuntime, agentReadiness,
    pendingAttachments, handleRemoveAttachment, uploadError, previewState, setPreviewState,
    previewCollapsed, setPreviewCollapsed, previewMaximized, setPreviewMaximized, previewWidth,
    setPreviewWidth, executionDetail, setExecutionDetail, httpRef, observationClient,
    viewportMemory, openTrajectory, openBilling, handleSelectWorkspace, handleCreateWorkspace,
    handleOpenArtifact, handleLoadMoreConversations, handleSelectSession, handleNewSession, handleRefreshAgentReadiness,
    handleOpenAgentSettings, handleDeleteSession, handleFilesSelected, handleClearSessions, handleAuth,
    handleLogin, activeWorkspace, selectedId, selectedMetadata, selectedTrajectoryTurn,
    selectedBillingTurn, running, requiredBlock, composerDisabled, composerBlockedReason,
    handleDraftChange, handleSend, handleCancelTurn, executionDetailTurn, executionDetailOpen,
    failedInput: Boolean(failedInput), handleRestoreFailedInput,
  };
}
function activationMessage(result: WebSessionActivationResult): string | null {
  if (result.state === 'active') return null;
  if (result.state === 'browsable') return '会话已打开为只读历史。';
  return {
    planner_turn_active: 'Planner 正在处理当前请求，完成前不能切换会话。',
    task_runtime_active: '当前 Task 仍在执行或等待处理，不能强制切换会话。',
    session_unavailable: '会话不存在、已归档或无法恢复。',
  }[result.reason];
}
