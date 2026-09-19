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
  InteractionTrace,
  InteractionTraceEvent,
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
  retainTerminalLiveTurnInRecord,
  retainLiveTurnForConversation,
} from './conversation-live-turn';
import { useThemePreference } from './theme';
import { projectTurnForPresentation } from './turn-task-presentation';
import { requiredAgentBlock } from './agent-readiness';
import { evaluateAttachmentBudget } from './attachment-limits';

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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [browsedSessionId, setBrowsedSessionId] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<WebSessionRecord | null>(null);
  const [liveTurn, setLiveTurn] = useState<ConversationTurnProjection | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('conversation');
  const [selectedTrajectoryTurnId, setSelectedTrajectoryTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
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
  const browsedConversationRef = useRef<string | null>(null);
  const liveTurnRef = useRef<ConversationTurnProjection | null>(null);
  const loadRecordRef = useRef<(sessionId: string) => void>(() => undefined);
  const conversationRequestRef = useRef(0);
  const recordRequestRef = useRef(0);
  const workspaceSwitchRef = useRef(false);
  const workspaceSwitchRequestRef = useRef(0);
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
    const handleUnauthorized = () => {
      setAuthenticated(false);
      setConnected(false);
      setAuthError('Web 会话已失效。请重新启动 Web 或输入 --no-open 显示的 token。');
    };
    const http = new HttpClient(handleUnauthorized);
    httpRef.current = http;
    const loadRecord = (sessionId: string) => {
      const requestId = ++recordRequestRef.current;
      void http.getConversation(sessionId)
        .then(record => {
          if (isCurrentConversationRecordRequest({
            requestId,
            latestRequestId: recordRequestRef.current,
            requestedSessionId: sessionId,
            browsedSessionId: browsedConversationRef.current,
          })) {
            setSelectedRecord(record);
          }
        })
        .catch(error => {
          if (isCurrentConversationRecordRequest({
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
          loadRecord(sessionId);
        }
      },
      onSessionCatalog: (sessionId, nextSessions) => {
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
        if (
          browsedConversationRef.current === sessionId
          && nextSessions.some(session => session.id === sessionId)
        ) {
          loadRecord(sessionId);
        }
      },
      onWorkspaceDirectory: (workspaceId, sessionId, nextSessions) => {
        setActiveWorkspaceId(workspaceId);
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
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
      onActiveSessionChanged: sessionId => {
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
        loadRecord(sessionId);
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
      onConfigurationRuntimeState: state => setConfigurationRuntime(state),
      onAgentReadinessState: agents => setAgentReadiness(agents),
      onExecution: (turnId, taskId, timeline) => {
        liveTurnRef.current = liveTurnRef.current
          && liveTurnRef.current.id === turnId
          && (!liveTurnRef.current.taskId || liveTurnRef.current.taskId === taskId)
          ? { ...liveTurnRef.current, taskId, executionTimeline: timeline }
          : liveTurnRef.current;
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
        liveTurnRef.current = liveTurnRef.current && liveTurnRef.current.id === turnId
          ? {
            ...liveTurnRef.current,
            status: backgroundWorkPending ? 'running' : 'completed',
            finalAnswer: lines.join('\n'),
            completedAt: backgroundWorkPending ? null : completedAt,
          }
          : liveTurnRef.current;
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
      onStatusChange: setConnected,
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
    void Promise.all([http.getWorkspaces(), http.getConfig()])
      .then(async ([workspaceCatalog, config]) => {
        const applied = await applyStartupLaunchSuggestion(
          http,
          workspaceCatalog,
          startupLaunchSuggestion,
        );
        setWorkspaces(applied.workspaces);
        setActiveWorkspaceId(applied.activeWorkspaceId);
        const catalog = applied.activeWorkspaceId
          ? await http.getConversations(applied.activeWorkspaceId)
          : null;
        const requestedConversationId = startupLaunchSuggestion?.conversationId ?? null;
        const initialSessionId = selectInitialSessionId(
          catalog?.conversations ?? [],
          requestedConversationId,
          catalog?.activeConversationId ?? null,
        );
        const initialSession = initialSessionId
          ? catalog?.conversations.find(session => session.id === initialSessionId)
          : undefined;
        let resolvedActiveSessionId = catalog?.activeConversationId ?? null;
        if (initialSession && initialSession.id !== catalog?.activeConversationId) {
          const activation = await http.attachConversation(initialSession.id).catch(() => null);
          if (activation?.state === 'active') resolvedActiveSessionId = initialSession.id;
        }
        setSessions(catalog?.conversations ?? []);
        // WebSocket 事件可能在本启动快照返回前就已建立活动会话。此时不得用陈旧目录覆盖它，
        // 否则后续会话点击会误判为“已附加”而跳过 attach。
        const liveSessionId = requestedConversationId ? null : activeConversationRef.current;
        const activeInWorkspace = liveSessionId ?? (
          catalog?.conversations.some(session => session.id === resolvedActiveSessionId)
            ? resolvedActiveSessionId
            : null
        );
        const resolvedSessionId = initialSessionId ?? activeInWorkspace;
        activeConversationRef.current = activeInWorkspace;
        setActiveSessionId(activeInWorkspace);
        const nextBrowsedSessionId = browsedConversationRef.current ?? resolvedSessionId;
        browsedConversationRef.current = nextBrowsedSessionId;
        setBrowsedSessionId(nextBrowsedSessionId);
        setConfigurationRuntime(config);
        if (activeInWorkspace) loadRecord(activeInWorkspace);
      })
      .catch(() => undefined);
    return () => {
      loadRecordRef.current = () => undefined;
      window.removeEventListener('focus', handleReadinessFocus);
      ws.close();
    };
  }, [authenticated, startupLaunchSuggestion]);

  useEffect(() => {
    if (!authenticated || !httpRef.current || !activeWorkspaceId) return;
    const requestId = ++conversationRequestRef.current;
    const requestedWorkspaceId = activeWorkspaceId;
    const timer = window.setTimeout(() => {
      void httpRef.current?.getConversations(requestedWorkspaceId, search)
        .then(result => {
          if (
            requestId !== conversationRequestRef.current
            || result.activeWorkspaceId !== requestedWorkspaceId
          ) {
            return;
          }
          setSessions(result.conversations);
        })
        .catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [authenticated, activeWorkspaceId, search]);

  useEffect(() => setSelectedTrajectoryTurnId(null), [activeWorkspaceId, browsedSessionId]);

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
    const switchRequestId = ++workspaceSwitchRequestRef.current;
    ++conversationRequestRef.current;
    ++recordRequestRef.current;
    setWorkspaceSwitching(true);
    setActivationNotice(null);
    try {
      const result = await http.selectWorkspace(workspacePath);
      if (result.selection.status === 'failed' || !result.activeWorkspaceId) {
        const message = result.selection.status === 'failed'
          ? `Workspace 切换失败：${result.selection.reason}`
          : 'Workspace 切换失败：Server 未返回 workspaceId。';
        setActivationNotice(message);
        return message;
      }
      const [workspaceCatalog, catalog] = await Promise.all([
        http.getWorkspaces(),
        http.getConversations(result.activeWorkspaceId),
      ]);
      if (switchRequestId !== workspaceSwitchRequestRef.current) return null;
      const workspaceActiveSessionId = catalog.conversations.some(
        session => session.id === result.activeSessionId,
      )
        ? result.activeSessionId
        : null;
      setWorkspaces(workspaceCatalog.workspaces);
      setActiveWorkspaceId(result.activeWorkspaceId);
      activeConversationRef.current = workspaceActiveSessionId;
      browsedConversationRef.current = workspaceActiveSessionId;
      setActiveSessionId(workspaceActiveSessionId);
      setSessions(catalog.conversations);
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
    const result = await httpRef.current.attachConversation(sessionId);
    setActivationNotice(activationMessage(result));
    if (result.state === 'active') {
      const record = await httpRef.current.getConversation(sessionId);
      const targetWorkspaceId = record.session.workspaceId;
      if (targetWorkspaceId) {
        const [workspaceCatalog, catalog] = await Promise.all([
          httpRef.current.getWorkspaces(),
          httpRef.current.getConversations(targetWorkspaceId),
        ]);
        setWorkspaces(workspaceCatalog.workspaces);
        setActiveWorkspaceId(targetWorkspaceId);
        setSessions(catalog.conversations);
      }
      activeConversationRef.current = sessionId;
      browsedConversationRef.current = sessionId;
      setActiveSessionId(sessionId);
      setBrowsedSessionId(sessionId);
      setPreviewState({ status: 'closed' });
      setExecutionDetail(null);
      setSelectedRecord(record);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    if (workspaceSwitchRef.current) return;
    browsedConversationRef.current = sessionId;
    setBrowsedSessionId(sessionId);
    setActivationNotice(null);
    setPreviewState({ status: 'closed' });
    setExecutionDetail(null);
    if (sessionId === activeConversationRef.current) {
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
    try {
      const result = await httpRef.current.createConversation(activeWorkspaceId);
      const catalog = await httpRef.current.getConversations(activeWorkspaceId);
      setSessions(catalog.conversations);
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
        {!selectedId
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
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(subtaskId, subtaskTitle) => {
                const target = turns.at(-1);
                if (target) setExecutionDetail({ subtaskId, subtaskTitle, turnId: target.id });
              }}
              onOpenTrajectory={turnId => {
                setSelectedTrajectoryTurnId(turnId);
                setTab('trajectory');
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

function mergeTraceSnapshot(
  current: ConversationTurnProjection | null,
  trace: InteractionTrace,
): ConversationTurnProjection | null {
  if (!current || current.id !== trace.turnId) return current;
  return {
    ...current,
    taskId: trace.taskId,
    status: trace.status,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    traceEvents: trace.events,
  };
}

function mergeTraceDelta(
  current: ConversationTurnProjection | null,
  turnId: string,
  events: InteractionTraceEvent[],
  status?: InteractionTrace['status'],
  completedAt?: string | null,
): ConversationTurnProjection | null {
  if (!current || current.id !== turnId) return current;
  const byId = new Map(current.traceEvents.map(event => [event.id, event]));
  for (const event of events) byId.set(event.id, event);
  return {
    ...current,
    ...(status ? {
      status,
      completedAt: status === 'running' ? null : completedAt ?? current.completedAt,
    } : {}),
    traceEvents: [...byId.values()].sort((left, right) => left.sequence - right.sequence),
  };
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

async function applyStartupLaunchSuggestion(
  http: HttpClient,
  catalog: { activeWorkspaceId: string | null; workspaces: WorkspaceSummary[] },
  suggestion: WebLaunchSuggestion | null,
): Promise<{ activeWorkspaceId: string | null; workspaces: WorkspaceSummary[] }> {
  const hint = suggestion?.workspaceHint;
  if (catalog.activeWorkspaceId || !hint) return catalog;
  const selection = await http.selectWorkspace(hint).catch(() => null);
  if (!selection?.activeWorkspaceId) return catalog;
  const refreshed = await http.getWorkspaces().catch(() => null);
  return {
    activeWorkspaceId: selection.activeWorkspaceId,
    workspaces: refreshed?.workspaces ?? catalog.workspaces,
  };
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
