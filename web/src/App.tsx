import { useEffect, useRef, useState } from 'react';
import { HttpClient } from './api/http';
import type {
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './api/session-types';
import { WsClient } from './api/ws';
import { establishWebSession, exchangeWebCredential } from './auth';
import { ConversationView } from './components/ConversationView';
import { SettingsPanel } from './components/SettingsPanel';
import { TokenGate } from './components/TokenGate';
import { TrajectoryView } from './components/TrajectoryView';
import { WorkspaceShell } from './components/WorkspaceShell';
import type { WorkspaceTab } from './components/WorkspaceHeader';

let startupAuthentication: Promise<boolean> | null = null;

export function App() {
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
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const httpRef = useRef<HttpClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);

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
        setActiveSessionId(sessionId);
        setBrowsedSessionId(current => current ?? sessionId);
        loadRecord(sessionId);
      },
      onSessionCatalog: (sessionId, nextSessions) => {
        setActiveSessionId(sessionId);
        setSessions(nextSessions);
      },
      onActiveSessionChanged: sessionId => {
        setActiveSessionId(sessionId);
        setBrowsedSessionId(sessionId);
        setLiveTurn(null);
        setActivationNotice(null);
        loadRecord(sessionId);
      },
      onConversationSnapshot: turn => setLiveTurn(turn),
      onError: message => setActivationNotice(`执行错误：${message}`),
      onUnauthorized: handleUnauthorized,
      onStatusChange: setConnected,
    });
    wsRef.current = ws;
    ws.connect();
    void Promise.all([http.getSessions(), http.getConfig()])
      .then(([catalog, config]) => {
        setSessions(catalog.sessions);
        setActiveSessionId(catalog.activeSessionId);
        setBrowsedSessionId(current => current ?? catalog.activeSessionId);
        setRevisionId(config.runningRevisionId);
        loadRecord(catalog.activeSessionId);
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

  const handleSelectSession = (sessionId: string) => {
    setBrowsedSessionId(sessionId);
    setActivationNotice(null);
    void httpRef.current?.getSession(sessionId)
      .then(setSelectedRecord)
      .catch(error => setActivationNotice((error as Error).message));
  };

  const handleActivation = async (sessionId: string) => {
    if (!httpRef.current) return;
    const result = await httpRef.current.activateSession(sessionId);
    setActivationNotice(activationMessage(result));
    if (result.state === 'active') {
      setActiveSessionId(sessionId);
      setBrowsedSessionId(sessionId);
      setLiveTurn(null);
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
      setActiveSessionId(result.session.session.id);
      setLiveTurn(null);
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

  if (authenticated === null) {
    return <div className="token-gate"><div className="token-gate-card">正在连接 AnyFusion…</div></div>;
  }
  if (!authenticated) return <TokenGate error={authError} onAuth={handleAuth} />;

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
        revisionId={revisionId}
        draft={draft}
        composerDisabled={readOnly}
        running={running}
        blockedReason={readOnly ? '当前为历史只读视图。点击左侧“继续此会话”通过安全激活门。' : activationNotice}
        onSearch={setSearch}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onContinueSession={sessionId => void handleActivation(sessionId)}
        onSettings={() => setSettingsOpen(true)}
        onTabChange={setTab}
        onDraftChange={setDraft}
        onSend={text => {
          wsRef.current?.sendInput(text);
          setDraft('');
          setActivationNotice(null);
        }}
      >
        {tab === 'conversation'
          ? <ConversationView turns={turns} />
          : <TrajectoryView turn={latestTurn} />}
      </WorkspaceShell>
      {settingsOpen && (
        <SettingsPanel http={httpRef.current} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
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
