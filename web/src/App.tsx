import { useEffect, useRef, useState } from 'react';
import { HttpClient } from './api/http';
import type {
  ArtifactProjection,
  AttachmentMetadata,
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './api/session-types';
import type { ConfigurationRuntimeState, InteractionTrace, InteractionTraceEvent } from './api/types';
import { WsClient } from './api/ws';
import { establishWebSession, exchangeWebCredential, loginWithPassword } from './auth';
import { ConversationView } from './components/ConversationView';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenGate } from './components/TokenGate';
import { TrajectoryView } from './components/TrajectoryView';
import { WorkspaceShell } from './components/WorkspaceShell';
import {
  ArtifactPreviewDrawer,
  type PreviewDrawerState,
} from './components/ArtifactPreviewDrawer';
import { ExecutionDetailDrawer } from './components/ExecutionDetailDrawer';
import type { WorkspaceTab } from './components/WorkspaceHeader';
import { useThemePreference } from './theme';

let startupAuthentication: Promise<boolean> | null = null;

export function App() {
  const [themePreference, setThemePreference] = useThemePreference();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<WebSessionMetadata[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [browsedSessionId, setBrowsedSessionId] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<WebSessionRecord | null>(null);
  const [liveTurn, setLiveTurn] = useState<ConversationTurnProjection | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('conversation');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configurationRuntime, setConfigurationRuntime] = useState<ConfigurationRuntimeState | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMetadata[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewDrawerState>({ status: 'closed' });
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [executionDetail, setExecutionDetail] = useState<{
    subtaskId: string;
    subtaskTitle: string;
    turnId: string;
  } | null>(null);
  const httpRef = useRef<HttpClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const activeConversationRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    startupAuthentication ??= establishWebSession();
    void startupAuthentication
      .then(ok => {
        if (active) setAuthenticated(ok);
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
      void http.getSession(sessionId)
        .then(setSelectedRecord)
        .catch(error => setActivationNotice((error as Error).message));
    };
    const ws = new WsClient({
      onHello: sessionId => {
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setBrowsedSessionId(current => current ?? sessionId);
        loadRecord(sessionId);
      },
      onSessionCatalog: (sessionId, nextSessions) => {
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
      },
      onActiveSessionChanged: sessionId => {
        activeConversationRef.current = sessionId;
        setActiveSessionId(sessionId);
        setBrowsedSessionId(sessionId);
        setLiveTurn(null);
        setActivationNotice(null);
        // 切换会话后旧会话的预览与执行详情不得残留。
        setPreviewState({ status: 'closed' });
        setExecutionDetail(null);
        loadRecord(sessionId);
      },
      onConversationSnapshot: turn => setLiveTurn(turn),
      onTurnStarted: (_requestId, turnId, userInput, startedAt) => {
        setLiveTurn({
          id: turnId,
          sessionId: activeConversationRef.current ?? 'active',
          userInput,
          status: 'running',
          finalAnswer: null,
          taskId: null,
          startedAt,
          completedAt: null,
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
          artifacts: [],
        });
      },
      onTraceSnapshot: trace => {
        setLiveTurn(current => mergeTraceSnapshot(current, trace));
      },
      onTraceDelta: (turnId, _fromSequence, events) => {
        setLiveTurn(current => mergeTraceDelta(current, turnId, events));
      },
      onConfigurationRuntimeState: state => setConfigurationRuntime(state),
      onExecution: (taskId, timeline) => {
        setLiveTurn(current => current
          ? { ...current, taskId, executionTimeline: timeline }
          : current);
      },
      onFinalAnswer: (_requestId, turnId, lines, completedAt) => {
        setLiveTurn(current => current && current.id === turnId
          ? {
            ...current,
            status: 'completed',
            finalAnswer: lines.join('\n'),
            completedAt,
          }
          : current);
      },
      onResultDeliveryAvailable: (_requestId, turnId, _resultId, certification) => {
        setLiveTurn(current => current && current.id === turnId
          ? {
            ...current,
            finalAnswer: certification === 'uncertified'
              ? '结果正在流式返回，任务完成认证待处理。\n\n'
              : '',
          }
          : current);
      },
      onResultChunk: (_requestId, turnId, _resultId, offset, chunk) => {
        setLiveTurn(current => current && current.id === turnId
          ? {
            ...current,
            finalAnswer: appendUtf8Chunk(current.finalAnswer ?? '', offset, chunk),
          }
          : current);
      },
      onResultCompleted: (_requestId, turnId, _resultId, content, _certification) => {
        setLiveTurn(current => current && current.id === turnId
          ? {
            ...current,
            finalAnswer: content,
          }
          : current);
      },
      onTerminalError: (_requestId, turnId, message, completedAt) => {
        setLiveTurn(current => current && current.id === turnId
          ? {
            ...current,
            status: 'failed',
            finalAnswer: message,
            completedAt,
          }
          : current);
      },
      onOutput: lines => {
        if (lines.some(line => line.startsWith('错误:'))) {
          setActivationNotice(lines.join('\n'));
        }
      },
      onError: message => setActivationNotice(`执行错误：${message}`),
      onUnauthorized: handleUnauthorized,
      onStatusChange: setConnected,
    });
    wsRef.current = ws;
    ws.connect();
    void Promise.all([http.getSessions(), http.getConfig()])
      .then(async ([catalog, config]) => {
        const requestedConversationId = new URLSearchParams(window.location.search).get('conversation');
        const requested = requestedConversationId
          ? catalog.sessions.find(session => session.id === requestedConversationId)
          : undefined;
        if (requested && requested.id !== catalog.activeSessionId) {
          await http.activateSession(requested.id).catch(() => undefined);
        }
        setSessions(catalog.sessions);
        const initialSessionId = requested?.id ?? catalog.activeSessionId;
        activeConversationRef.current = initialSessionId;
        setActiveSessionId(initialSessionId);
        setBrowsedSessionId(current => current ?? initialSessionId);
        setConfigurationRuntime(config);
        loadRecord(initialSessionId);
      })
      .catch(() => undefined);
    return () => ws.close();
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !httpRef.current) return;
    const timer = window.setTimeout(() => {
      void httpRef.current?.getSessions(search)
        .then(result => setSessions(result.sessions))
        .catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [authenticated, search]);

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

  const handleSelectSession = (sessionId: string) => {
    setBrowsedSessionId(sessionId);
    setActivationNotice(null);
    setPreviewState({ status: 'closed' });
    setExecutionDetail(null);
    void httpRef.current?.getSession(sessionId)
      .then(setSelectedRecord)
      .catch(error => setActivationNotice((error as Error).message));
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
    const result = await httpRef.current.activateSession(sessionId);
    setActivationNotice(activationMessage(result));
    if (result.state === 'active') {
      activeConversationRef.current = sessionId;
      setActiveSessionId(sessionId);
      setBrowsedSessionId(sessionId);
      setLiveTurn(null);
      setPreviewState({ status: 'closed' });
      setExecutionDetail(null);
      setSelectedRecord(await httpRef.current.getSession(sessionId));
    }
  };

  const handleNewSession = async () => {
    if (!httpRef.current) return;
    const result = await httpRef.current.createSession();
    setSessions(current => [
      result.session.session,
      ...current.filter(session => session.id !== result.session.session.id),
    ]);
    setBrowsedSessionId(result.session.session.id);
    setSelectedRecord(result.session);
    setActivationNotice(activationMessage(result.activation));
    if (result.activation.state === 'active') {
      activeConversationRef.current = result.session.session.id;
      setActiveSessionId(result.session.session.id);
      setLiveTurn(null);
      setPreviewState({ status: 'closed' });
      setExecutionDetail(null);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!httpRef.current) return;
    try {
      await httpRef.current.deleteSession(sessionId);
      setSessions(current => current.filter(session => session.id !== sessionId));
      if (browsedSessionId === sessionId) {
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
    for (const file of files) {
      if (pendingAttachments.length >= 32) {
        setUploadError('单条消息最多 32 个附件。');
        break;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const metadata = await httpRef.current.uploadAttachment(
          activeSessionId,
          file.name,
          bytes,
        );
        setPendingAttachments(current => [...current, metadata]);
      } catch (error) {
        setUploadError(`上传 ${file.name} 失败：${(error as Error).message}`);
      }
    }
  };

  const handleClearSessions = async () => {
    if (!httpRef.current) return;
    try {
      const result = await httpRef.current.clearSessions();
      setSessions(current => current.filter(session => session.id === activeSessionId));
      if (browsedSessionId && browsedSessionId !== activeSessionId) {
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
      const ok = await exchangeWebCredential(token);
      setAuthError(ok ? null : 'token 无效或已过期。');
      if (ok) setAuthenticated(true);
      return ok;
    } catch (error) {
      setAuthError((error as Error).message);
      return false;
    }
  };

  const handleLogin = async (username: string, password: string): Promise<boolean> => {
    try {
      const ok = await loginWithPassword(username, password);
      setAuthError(ok ? null : '用户名或密码错误，或尝试次数过多，请稍后再试。');
      if (ok) setAuthenticated(true);
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

  const selectedId = browsedSessionId ?? activeSessionId;
  const selectedMetadata = sessions.find(session => session.id === selectedId)
    ?? selectedRecord?.session;
  const turns: ConversationTurnProjection[] = [...(selectedRecord?.turns ?? [])];
  if (selectedId === activeSessionId && liveTurn) {
    const existingIndex = turns.findIndex(turn => turn.id === liveTurn.id);
    if (existingIndex >= 0) turns[existingIndex] = liveTurn;
    else turns.push(liveTurn);
  }
  const latestTurn = turns.at(-1) ?? null;
  const readOnly = Boolean(selectedId && selectedId !== activeSessionId);
  const running = Boolean(selectedId === activeSessionId && liveTurn?.status === 'running');
  const composerDisabled = readOnly || !connected;
  const composerBlockedReason = readOnly
    ? '当前为历史只读视图。点击左侧“继续此会话”通过安全激活门。'
    : !connected
      ? 'WebSocket 尚未连接，消息不会丢失。连接恢复后再发送。'
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
        activeSessionId={activeSessionId}
        selectedSessionId={selectedId}
        search={search}
        title={selectedMetadata?.title ?? 'New session'}
        tab={tab}
        connected={connected}
        themePreference={themePreference}
        composerVisible={tab === 'conversation'}
        draft={draft}
        composerDisabled={composerDisabled}
        running={running}
        blockedReason={composerBlockedReason}
        previewOpen={previewState.status !== 'closed' || executionDetailOpen}
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
            onClose={() => {
              setPreviewState({ status: 'closed' });
              setPreviewCollapsed(false);
            }}
            onToggleCollapse={() => setPreviewCollapsed(current => !current)}
          />
        )}
        onSearch={setSearch}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onContinueSession={sessionId => void handleActivation(sessionId)}
        onDeleteSession={sessionId => void handleDeleteSession(sessionId)}
        onClearSessions={() => void handleClearSessions()}
        onSettings={() => setSettingsOpen(true)}
        onTabChange={setTab}
        onThemeChange={setThemePreference}
        onDraftChange={setDraft}
        onSend={(text, attachments) => {
          const sent = (wsRef.current?.sendInput(text, attachments) ?? false);
          if (!sent) {
            setActivationNotice('WebSocket 尚未连接，消息仍保留在输入框中。');
            return;
          }
          setDraft('');
          setPendingAttachments([]);
          setActivationNotice(null);
        }}
        attachments={pendingAttachments.map(metadata => ({ metadata }))}
        uploadError={uploadError}
        onFilesSelected={files => void handleFilesSelected(files)}
        onRemoveAttachment={attachmentId => setPendingAttachments(current =>
          current.filter(entry => entry.attachmentId !== attachmentId))}
      >
        {tab === 'conversation'
          ? (
            <ConversationView
              turns={turns}
              running={running}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(subtaskId, subtaskTitle) => {
                const target = turns.at(-1);
                if (target) setExecutionDetail({ subtaskId, subtaskTitle, turnId: target.id });
              }}
            />
          )
          : (
            <TrajectoryView
              turn={latestTurn}
              http={httpRef.current}
              onOpenArtifact={handleOpenArtifact}
              onOpenSubtaskDetail={(subtaskId, subtaskTitle) => {
                if (latestTurn) setExecutionDetail({ subtaskId, subtaskTitle, turnId: latestTurn.id });
              }}
            />
          )}
      </WorkspaceShell>
      {settingsOpen && (
        <SettingsPanel
          http={httpRef.current}
          runtime={configurationRuntime}
          onClose={() => setSettingsOpen(false)}
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
): ConversationTurnProjection | null {
  if (!current || current.id !== turnId) return current;
  const byId = new Map(current.traceEvents.map(event => [event.id, event]));
  for (const event of events) byId.set(event.id, event);
  return {
    ...current,
    traceEvents: [...byId.values()].sort((left, right) => left.sequence - right.sequence),
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
