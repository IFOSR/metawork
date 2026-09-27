import { useEffect, useRef, useState } from 'react';
import { HttpClient } from './api/http';
import type {
  ArtifactProjection,
  AttachmentMetadata,
  ConversationWorkspaceProjection,
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionMetadata,
  WebSessionRecord,
  WorkspaceSummary,
} from './api/session-types';
import type {
  AgentReadiness,
  ConfigurationRuntimeState,
} from './api/types';
import { WsClient } from './api/ws';
import {
  establishWebSession,
  exchangeWebCredential,
  loginWithPassword,
  resolveWebLaunchSuggestion,
  type WebLaunchSuggestion,
} from './auth';
import { ConversationView } from './components/ConversationView';
import { BillingView } from './components/BillingView';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenGate } from './components/TokenGate';
import { TrajectoryView } from './components/TrajectoryView';
import { WorkspaceCreator } from './components/WorkspaceCreator';
import { WorkspaceShell } from './components/WorkspaceShell';
import { selectInitialSessionId } from './session-selection';
import {
  ArtifactPreviewDrawer,
  type PreviewDrawerState,
} from './components/ArtifactPreviewDrawer';
import { ExecutionDetailDrawer } from './components/ExecutionDetailDrawer';
import type { WorkspaceTab } from './components/WorkspaceHeader';
import {
  isCurrentConversationRecordRequest,
  mergeFinalAnswer,
  mergeExecutionTimeline,
  mergeTraceDelta,
  mergeTraceSnapshot,
  mergeBilling,
  retainTerminalLiveTurnInRecord,
  retainLiveTurnForConversation,
} from './conversation-live-turn';
import { useThemePreference } from './theme';
import { projectTurnForPresentation } from './turn-task-presentation';
import { requiredAgentBlock } from './agent-readiness';
import { evaluateAttachmentBudget } from './attachment-limits';
import { canLoadDirectoryPage, createNavigationGuard, loadStartupWorkspace, loadWorkspaceSelection } from './navigation-requests';
import { NavigationDirectoryChanges, shouldActivateConversation } from './navigation-directory-state';
import { mergeNewestHistoryPage } from './navigation-history-state';

let startupAuthentication: ReturnType<typeof establishWebSession> | null = null;
let startupLaunchSuggestionPromise: Promise<WebLaunchSuggestion | null> | null = null;

export function App() {
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
  const [selectedRecord, setSelectedRecord] = useState<WebSessionRecord | null>(null);
  const directoryChangesRef = useRef(new NavigationDirectoryChanges());
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequestRef = useRef(0);
  const [liveTurn, setLiveTurn] = useState<ConversationTurnProjection | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('conversation');
  const [selectedTrajectoryTurnId, setSelectedTrajectoryTurnId] = useState<string | null>(null);
  const [selectedBillingTurnId, setSelectedBillingTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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
  } | null>(null);
  const httpRef = useRef<HttpClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const activeWorkspaceRef = useRef<string | null>(null);
  const browsedConversationRef = useRef<string | null>(null);
  const liveTurnRef = useRef<ConversationTurnProjection | null>(null);
  const loadRecordRef = useRef<(sessionId: string) => void>(() => undefined);
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
    draft: string;
    attachments: AttachmentMetadata[];
  }>());
  const readinessFocusRefreshRef = useRef(false);

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
      workspaceId: activeWorkspaceRef.current,
      conversationId: browsedConversationRef.current,
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
    let recordRead: { key: string; promise: Promise<WebSessionRecord> } | null = null;
    const readRecord = (sessionId: string, reuse: boolean) => {
      const key = JSON.stringify([
        sessionId, workspaceSwitchRequestRef.current, conversationNavigationRef.current.generation,
      ]);
      if (!reuse || recordRead?.key !== key) {
        const promise = http.getConversation(sessionId);
        recordRead = { key, promise };
        void promise.catch(() => {
          if (recordRead?.promise === promise) recordRead = null;
        });
      }
      return recordRead.promise;
    };
    const loadRecord = (sessionId: string, reuse = false) => {
      const requestId = ++recordRequestRef.current;
      void readRecord(sessionId, reuse)
        .then(record => {
          if (startupLifetime.current() && isCurrentConversationRecordRequest({
            requestId,
            latestRequestId: recordRequestRef.current,
            requestedSessionId: sessionId,
            browsedSessionId: browsedConversationRef.current,
          })) {
            setSelectedRecord(current => mergeNewestHistoryPage(current, record));
          }
        })
        .catch(error => {
          if (startupLifetime.current() && isCurrentConversationRecordRequest({
            requestId,
            latestRequestId: recordRequestRef.current,
            requestedSessionId: sessionId,
            browsedSessionId: browsedConversationRef.current,
          })) {
            setActivationNotice((error as Error).message);
          }
        });
    };
    loadRecordRef.current = loadRecord;
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
          current && nextSessions.some(session => session.id === current.session.id)
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
        setSelectedRecord(current => current?.session.id === event.conversationId
          && current.session.workspaceId === event.workspaceId && event.changes
          ? { ...current, session: { ...current.session, ...event.changes } } : current);
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
        liveTurnRef.current = retainLiveTurnForConversation(liveTurnRef.current, sessionId);
        setLiveTurn(liveTurnRef.current);
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
        setSelectedRecord(current => current?.session.id === sessionId
          ? {
            ...current,
            session: { ...current.session, workspace },
          }
          : current);
      },
      onConversationSnapshot: turn => {
        liveTurnRef.current = turn;
        setLiveTurn(turn);
      },
      onTurnStarted: (_requestId, turnId, userInput, startedAt, interactionKind) => {
        pendingInputsRef.current.delete(_requestId);
        setSelectedRecord(current => retainTerminalLiveTurnInRecord(
          current,
          liveTurnRef.current,
        ));
        const nextTurn: ConversationTurnProjection = {
          id: turnId,
          sessionId: activeConversationRef.current ?? 'active',
          userInput,
          interactionKind: interactionKind
            ?? (userInput.trim().startsWith('/') ? 'system_command' : 'ai_turn'),
          status: 'running',
          finalAnswer: null,
          taskId: null,
          startedAt,
          completedAt: null,
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        };
        liveTurnRef.current = nextTurn;
        setLiveTurn(nextTurn);
      },
      onTraceSnapshot: trace => {
        liveTurnRef.current = mergeTraceSnapshot(liveTurnRef.current, trace);
        setLiveTurn(liveTurnRef.current);
      },
      onTraceDelta: (turnId, _fromSequence, events, status, completedAt) => {
        liveTurnRef.current = mergeTraceDelta(
          liveTurnRef.current,
          turnId,
          events,
          status,
          completedAt,
        );
        setLiveTurn(liveTurnRef.current);
      },
      onBilling: (turnId, queryBill, taskUsageSummary, turnBilling) => {
        liveTurnRef.current = mergeBilling(
          liveTurnRef.current, turnId, queryBill, taskUsageSummary, turnBilling,
        );
        setLiveTurn(liveTurnRef.current);
      },
      onConfigurationRuntimeState: state => setConfigurationRuntime(state),
      onAgentReadinessState: agents => setAgentReadiness(agents),
      onExecution: (turnId, taskId, timeline) => {
        liveTurnRef.current = mergeExecutionTimeline(liveTurnRef.current, turnId, timeline);
        setLiveTurn(liveTurnRef.current);
      },
      onArtifacts: (turnId, taskId, artifacts) => {
        liveTurnRef.current = liveTurnRef.current
          && liveTurnRef.current.id === turnId
          && (!liveTurnRef.current.taskId || liveTurnRef.current.taskId === taskId)
          ? {
            ...liveTurnRef.current,
            taskId,
            artifactRefs: [...new Set([
              ...liveTurnRef.current.artifactRefs,
              ...artifacts.map(artifact => artifact.relativePath),
            ])],
            artifacts: mergeArtifacts(liveTurnRef.current.artifacts, artifacts),
          }
          : liveTurnRef.current;
        setLiveTurn(liveTurnRef.current);
      },
      onFinalAnswer: (_requestId, turnId, lines, completedAt, backgroundWorkPending) => {
        liveTurnRef.current = mergeFinalAnswer(
          liveTurnRef.current, turnId, lines, completedAt, backgroundWorkPending,
        );
        setLiveTurn(liveTurnRef.current);
      },
      onResultDeliveryAvailable: (_requestId, turnId, _resultId, certification) => {
        liveTurnRef.current = liveTurnRef.current && liveTurnRef.current.id === turnId
          ? {
            ...liveTurnRef.current,
            finalAnswer: certification === 'uncertified'
              ? '结果正在流式返回，任务完成认证待处理。\n\n'
              : '',
          }
          : liveTurnRef.current;
        setLiveTurn(liveTurnRef.current);
      },
      onResultChunk: (_requestId, turnId, _resultId, offset, chunk) => {
        liveTurnRef.current = liveTurnRef.current && liveTurnRef.current.id === turnId
          ? {
            ...liveTurnRef.current,
            finalAnswer: appendUtf8Chunk(liveTurnRef.current.finalAnswer ?? '', offset, chunk),
          }
          : liveTurnRef.current;
        setLiveTurn(liveTurnRef.current);
      },
      onResultCompleted: (_requestId, turnId, _resultId, content, _certification) => {
        liveTurnRef.current = liveTurnRef.current && liveTurnRef.current.id === turnId
          ? {
            ...liveTurnRef.current,
            finalAnswer: content,
          }
          : liveTurnRef.current;
        setLiveTurn(liveTurnRef.current);
      },
      onTerminalError: (_requestId, turnId, message, completedAt) => {
        liveTurnRef.current = liveTurnRef.current && liveTurnRef.current.id === turnId
          ? {
            ...liveTurnRef.current,
            status: 'failed',
            finalAnswer: message,
            completedAt,
          }
          : liveTurnRef.current;
        setLiveTurn(liveTurnRef.current);
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
        if ((detail?.code === 'required_agent_unavailable' || detail?.code === 'no_enabled_executor') && pending && detail.requestId) {
          pendingInputsRef.current.delete(detail.requestId);
          setDraft(pending.draft);
          setPendingAttachments(pending.attachments);
          setActivationNotice(
            detail.code === 'no_enabled_executor'
              ? '当前没有启用的执行助手，请在设置中新增或启用至少一名助手。'
              : `当前无法开始新工作，请先安装${requiredAgentBlock(agentReadiness).agent?.displayName ?? '必需执行工具'}。`,
          );
          return;
        }
        // A rejected attachment budget never became a turn: restore the draft
        // and the pending attachments so the user can trim them instead of
        // losing the message.
        if (detail?.code?.startsWith('attachment_') && pending && detail.requestId) {
          pendingInputsRef.current.delete(detail.requestId);
          setDraft(pending.draft);
          setPendingAttachments(pending.attachments);
          setActivationNotice(message);
          return;
        }
        setActivationNotice(`执行错误：${message}`);
      },
      onUnauthorized: handleUnauthorized,
      onStatusChange: connected => {
        if (!connected) recordRead = null;
        if (startupLifetime.current()) setConnected(connected);
      },
    });
    wsRef.current = ws;
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
          workspaceCatalog,
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
        if (initialSessionId && initialSessionId !== catalog?.activeConversationId) {
          const navigation = conversationNavigationRef.current;
          navigation.target = initialSessionId;
          const activation = await (offPageRequest
            ? http.attachConversation(initialSessionId, applied.activeWorkspaceId!)
            : http.attachConversation(initialSessionId)).catch(() => null);
          if (conversationNavigationRef.current === navigation && navigation.target === initialSessionId) {
            navigation.target = null;
          }
          if (!startupGuard.current()) return;
          if (activation?.state === 'active') resolvedActiveSessionId = initialSessionId;
          else if (offPageRequest) initialSessionId = null;
        }
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
        // 否则后续会话点击会误判为“已附加”而跳过 attach。
        const liveSessionId = !requestedConversationId
          && catalog?.conversations.some(session => session.id === activeConversationRef.current)
          ? activeConversationRef.current : null;
        const activeInWorkspace = liveSessionId ?? (
          (initialSessionId !== null && initialSessionId === resolvedActiveSessionId
            || catalog?.conversations.some(session => session.id === resolvedActiveSessionId))
            ? resolvedActiveSessionId
            : null
        );
        const resolvedSessionId = initialSessionId ?? activeInWorkspace;
        activeConversationRef.current = activeInWorkspace;
        setActiveSessionId(activeInWorkspace);
        const nextBrowsedSessionId = resolvedSessionId;
        browsedConversationRef.current = nextBrowsedSessionId;
        setBrowsedSessionId(nextBrowsedSessionId);
        setConfigurationRuntime(config);
        if (nextBrowsedSessionId) {
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
      loadRecordRef.current = () => undefined;
      window.removeEventListener('focus', handleReadinessFocus);
      ws.close();
    };
  }, [authenticated, startupLaunchSuggestion]);

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
      liveTurnRef.current = null;
      setLiveTurn(null);
      setPreviewState({ status: 'closed' });
      setExecutionDetail(null);
      setActivationNotice(null);
      if (workspaceActiveSessionId) {
        const recordRequestId = ++recordRequestRef.current;
        void http.getConversation(workspaceActiveSessionId)
          .then(record => {
            if (
              recordRequestId === recordRequestRef.current
              && switchRequestId === workspaceSwitchRequestRef.current
            ) {
              setSelectedRecord(record);
            }
          })
          .catch(error => {
            if (
              recordRequestId === recordRequestRef.current
              && switchRequestId === workspaceSwitchRequestRef.current
            ) {
              setActivationNotice((error as Error).message);
            }
          });
      }
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
    setPreviewCollapsed(false);
    setPreviewState({ status: 'loading', artifactId: artifact.artifactId });
    void http.getArtifactPreview(artifact.artifactId)
      .then(result => setPreviewState(current => (
        current.status === 'loading' && current.artifactId === artifact.artifactId
          ? {
            status: 'ready',
            artifact: result.artifact,
            content: result.content,
            ...(result.renderedHtml ? { renderedHtml: result.renderedHtml } : {}),
          }
          : current
      )))
      .catch(error => setPreviewState(current => (
        current.status === 'loading' && current.artifactId === artifact.artifactId
          ? { status: 'error', artifactId: artifact.artifactId, message: (error as Error).message }
          : current
      )));
  };

  const handleActivation = async (sessionId: string) => {
    if (!httpRef.current) return;
    const generation = conversationNavigationRef.current.generation + 1;
    conversationNavigationRef.current = { generation, target: sessionId };
    const workspaceGeneration = workspaceSwitchRequestRef.current;
    const current = () => conversationNavigationRef.current.generation === generation
      && workspaceSwitchRequestRef.current === workspaceGeneration;
    ++recordRequestRef.current;
    try {
      const result = await httpRef.current.attachConversation(sessionId);
      if (!current()) return;
      setActivationNotice(activationMessage(result));
      if (result.state === 'active') {
        const record = await httpRef.current.getConversation(sessionId);
        if (!current()) return;
        activeConversationRef.current = sessionId;
        browsedConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setBrowsedSessionId(sessionId);
        setPreviewState({ status: 'closed' });
        setExecutionDetail(null);
        setSelectedRecord(record);
      }
    } finally {
      if (current()) conversationNavigationRef.current.target = null;
    }
  };

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

  const handleLoadOlderHistory = async () => {
    const http = httpRef.current;
    const record = selectedRecord;
    if (!http || !record?.historyCursor || historyLoading) return;
    const sessionId = record.session.id;
    const navigation = conversationNavigationRef.current.generation;
    const workspace = workspaceSwitchRequestRef.current;
    const request = ++historyRequestRef.current;
    const current = () => request === historyRequestRef.current
      && navigation === conversationNavigationRef.current.generation
      && workspace === workspaceSwitchRequestRef.current
      && browsedConversationRef.current === sessionId;
    setHistoryLoading(true);
    try {
      const page = await http.getConversation(sessionId, record.historyCursor);
      if (!current()) return;
      setSelectedRecord(existing => {
        if (!existing || existing.session.id !== sessionId) return existing;
        const ids = new Set(existing.turns.map(turn => turn.id));
        return {
          ...existing,
          turns: [...page.turns.filter(turn => !ids.has(turn.id)), ...existing.turns],
          historyCursor: page.historyCursor,
        };
      });
    } catch (error) {
      if (current()) setActivationNotice((error as Error).message);
    } finally {
      if (request === historyRequestRef.current) setHistoryLoading(false);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    if (workspaceSwitchRef.current) return;
    browsedConversationRef.current = sessionId;
    setBrowsedSessionId(sessionId);
    setActivationNotice(null);
    setPreviewState({ status: 'closed' });
    setExecutionDetail(null);
    if (!shouldActivateConversation(sessionId, activeConversationRef.current, conversationNavigationRef.current.target)) {
      loadRecordRef.current(sessionId);
      return;
    }
    setSelectedRecord(null);
    liveTurnRef.current = retainLiveTurnForConversation(liveTurnRef.current, sessionId);
    setLiveTurn(liveTurnRef.current);
    void handleActivation(sessionId).catch(error => {
      setActivationNotice((error as Error).message);
    });
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
      setSelectedRecord(result.session);
      setActivationNotice(activationMessage(result.activation));
      if (result.activation.state === 'active') {
        activeConversationRef.current = result.session.session.id;
        setActiveSessionId(result.session.session.id);
        liveTurnRef.current = null;
        setLiveTurn(null);
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
    if (!httpRef.current || !activeSessionId) {
      setUploadError('当前没有活跃会话，无法上传附件。');
      return;
    }
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
          activeSessionId,
          file.name,
          file,
        );
        selection.push({ name: metadata.name, size: metadata.size });
        setPendingAttachments(current => [...current, metadata]);
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

  if (authenticated === null) {
    return <div className="token-gate"><div className="token-gate-card">正在连接 MetaWork…</div></div>;
  }
  if (!authenticated) return <TokenGate error={authError} onLogin={handleLogin} onTokenAuth={handleAuth} />;

  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  const activeConversationInWorkspace = activeSessionId
    && sessions.some(session => session.id === activeSessionId)
    ? activeSessionId
    : null;
  const selectedId = browsedSessionId ?? activeConversationInWorkspace;
  const selectedMetadata = sessions.find(session => session.id === selectedId)
    ?? selectedRecord?.session;
  const turns: ConversationTurnProjection[] = (selectedRecord?.turns ?? [])
    .map(projectTurnForPresentation);
  if (selectedId === activeSessionId && liveTurn) {
    const projectedLiveTurn = projectTurnForPresentation(liveTurn);
    const existingIndex = turns.findIndex(turn => turn.id === liveTurn.id);
    if (existingIndex >= 0) turns[existingIndex] = projectedLiveTurn;
    else turns.push(projectedLiveTurn);
  }
  const latestTurn = turns.at(-1) ?? null;
  const selectedTrajectoryTurn = selectedTrajectoryTurnId
    ? turns.find(turn => turn.id === selectedTrajectoryTurnId) ?? latestTurn
    : latestTurn;
  const selectedBillingTurn = selectedBillingTurnId
    ? turns.find(turn => turn.id === selectedBillingTurnId) ?? latestTurn
    : latestTurn;
  const running = Boolean(selectedId === activeSessionId && liveTurn?.status === 'running');
  const requiredBlock = requiredAgentBlock(agentReadiness);
  const composerDisabled = selectedId !== activeSessionId || !connected || requiredBlock.blocked;
  const composerBlockedReason = workspaceSwitching
    ? '正在切换 Workspace…'
    : selectedId !== activeSessionId
      ? '正在加载当前会话…'
      : !connected
        ? 'WebSocket 尚未连接，消息不会丢失。连接恢复后再发送。'
        : requiredBlock.blocked
          ? requiredBlock.message
        : activationNotice;

  // 执行详情抽屉：只在目标 turn 仍可见时渲染；找不到时视为关闭。
  const executionDetailTurn = executionDetail
    ? turns.find(turn => turn.id === executionDetail.turnId) ?? null
    : null;
  const executionDetailOpen = executionDetail !== null && executionDetailTurn !== null;

  return (
    <>
      <WorkspaceShell
        sessions={sessions}
        hasMoreConversations={directoryCursor !== null}
        directoryLoading={directoryLoading}
        onLoadMoreConversations={() => void handleLoadMoreConversations()}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        activeSessionId={activeSessionId}
        selectedSessionId={selectedId}
        workspaceSwitching={workspaceSwitching}
        search={search}
        title={selectedMetadata?.title ?? activeWorkspace?.displayName ?? 'Workspace'}
        workspace={activeWorkspace}
        tab={tab}
        connected={connected}
        themePreference={themePreference}
        composerVisible={tab === 'conversation' && Boolean(selectedId)}
        draft={draft}
        composerDisabled={workspaceSwitching || composerDisabled}
        newWorkBlocked={requiredBlock.blocked}
        agentReadiness={agentReadiness}
        running={running}
        blockedReason={composerBlockedReason}
        previewOpen={previewState.status !== 'closed' || executionDetailOpen}
        previewMaximized={previewMaximized}
        previewDrawer={executionDetailOpen && executionDetail && executionDetailTurn ? (
          <ExecutionDetailDrawer
            turn={executionDetailTurn}
            subtaskId={executionDetail.subtaskId}
            onClose={() => setExecutionDetail(null)}
          />
        ) : (
          <ArtifactPreviewDrawer
            http={httpRef.current}
            state={previewState}
            collapsed={previewCollapsed}
            maximized={previewMaximized}
            width={previewWidth}
            onClose={() => {
              setPreviewState({ status: 'closed' });
              setPreviewCollapsed(false);
              setPreviewMaximized(false);
            }}
            onToggleCollapse={() => setPreviewCollapsed(current => !current)}
            onToggleMaximize={() => setPreviewMaximized(current => !current)}
            onResize={next => setPreviewWidth(clampPreviewWidth(next))}
          />
        )}
        onSearch={setSearch}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={() => setWorkspaceCreatorOpen(true)}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onDeleteSession={sessionId => void handleDeleteSession(sessionId)}
        onClearSessions={() => void handleClearSessions()}
        onSettings={handleOpenAgentSettings}
        onRefreshAgentReadiness={handleRefreshAgentReadiness}
        onTabChange={nextTab => {
          if (nextTab === 'trajectory') setSelectedTrajectoryTurnId(null);
          setTab(nextTab);
        }}
        onThemeChange={setThemePreference}
        onDraftChange={setDraft}
        onSend={(text, attachments) => {
          const requestId = wsRef.current?.sendInput(text, attachments) ?? null;
          if (!requestId) {
            setActivationNotice('WebSocket 尚未连接，消息仍保留在输入框中。');
            return;
          }
          pendingInputsRef.current.set(requestId, {
            draft: text,
            attachments: pendingAttachments,
          });
          setDraft('');
          setPendingAttachments([]);
          setActivationNotice(null);
        }}
        onCancelTurn={() => {
          const turnId = liveTurnRef.current?.id ?? '';
          if (!wsRef.current?.sendCancel(turnId)) {
            setActivationNotice('WebSocket 尚未连接，无法停止当前轮。');
            return;
          }
          setActivationNotice('已请求停止当前轮。');
        }}
        attachments={pendingAttachments.map(metadata => ({ metadata }))}
        uploadError={uploadError}
        onFilesSelected={files => void handleFilesSelected(files)}
        onRemoveAttachment={attachmentId => setPendingAttachments(current =>
          current.filter(entry => entry.attachmentId !== attachmentId))}
      >
        {tab === 'billing'
          ? (
            <BillingView
              bill={selectedBillingTurn?.queryBill ?? null}
              requestSummary={selectedBillingTurn?.userInput}
              taskTitle={selectedBillingTurn?.executionTimeline?.title}
            />
          )
          : !selectedId
          ? (
            <div className="workspace-home">
              <span className="workspace-home-kicker">WORKSPACE HOME</span>
              <h2>{activeWorkspace?.displayName ?? '选择一个 Workspace'}</h2>
              <p>
                {activeWorkspace
                  ? '选择左侧会话继续工作，或在当前 Workspace 新建一个独立会话。'
                  : '点击左侧添加按钮或此处按钮，选择本机目录创建 Workspace。'}
              </p>
              {activeWorkspace ? (
                <button
                  onClick={() => void handleNewSession()}
                  disabled={requiredBlock.blocked}
                >
                  新建会话
                </button>
              ) : (
                <button onClick={() => setWorkspaceCreatorOpen(true)}>添加 Workspace</button>
              )}
            </div>
          )
          : tab === 'conversation'
          ? (
            <ConversationView
              sessionId={selectedId}
              turns={turns}
              hasOlderHistory={Boolean(selectedRecord?.historyCursor)}
              historyLoading={historyLoading}
              onLoadOlderHistory={handleLoadOlderHistory}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(subtaskId, subtaskTitle) => {
                const target = turns.at(-1);
                if (target) setExecutionDetail({ subtaskId, subtaskTitle, turnId: target.id });
              }}
              onOpenTrajectory={turnId => {
                setSelectedTrajectoryTurnId(turnId);
                setTab('trajectory');
              }}
              onOpenBilling={turnId => {
                setSelectedBillingTurnId(turnId);
                setTab('billing');
              }}
            />
          )
          : (
            <TrajectoryView
              turn={selectedTrajectoryTurn}
              http={httpRef.current}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(subtaskId, subtaskTitle) => {
                if (selectedTrajectoryTurn) {
                  setExecutionDetail({
                    subtaskId,
                    subtaskTitle,
                    turnId: selectedTrajectoryTurn.id,
                  });
                }
              }}
            />
          )}
      </WorkspaceShell>
      {settingsOpen && (
        <SettingsPanel
          http={httpRef.current}
          runtime={configurationRuntime}
          agentReadiness={agentReadiness}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {workspaceCreatorOpen && (
        <WorkspaceCreator
          http={httpRef.current}
          open
          disabled={workspaceSwitching}
          onClose={() => setWorkspaceCreatorOpen(false)}
          onSelect={handleCreateWorkspace}
        />
      )}
    </>
  );
}

function appendUtf8Chunk(current: string, offset: number, chunk: string): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(current);
  if (offset === bytes.byteLength) return current + chunk;
  if (offset > bytes.byteLength) return current;
  return decoder.decode(bytes.slice(0, offset)) + chunk;
}

function mergeArtifacts(
  current: ArtifactProjection[],
  incoming: ArtifactProjection[],
): ArtifactProjection[] {
  const byId = new Map(current.map(artifact => [artifact.artifactId, artifact]));
  for (const artifact of incoming) byId.set(artifact.artifactId, artifact);
  return [...byId.values()].sort(
    (left, right) => left.publishedAt.localeCompare(right.publishedAt)
      || left.artifactId.localeCompare(right.artifactId),
  );
}

/**
 * 预览抽屉宽度限制：至少保留可读的对话列，也不超过视口以免出现横向滚动。
 */
function clampPreviewWidth(width: number): number {
  const viewport = typeof window === 'undefined' ? 1_440 : window.innerWidth;
  const max = Math.max(360, Math.min(viewport - 360, 1_200));
  return Math.round(Math.max(320, Math.min(width, max)));
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
