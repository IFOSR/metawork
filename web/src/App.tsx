import { useEffect, useRef, useState } from 'react';
import { HttpClient } from './api/http';
import { WsClient } from './api/ws';
import { mergeOutputLines } from './api/output-buffer';
import type { ExecutionTimeline, InteractionTrace } from './api/types';
import { TokenGate } from './components/TokenGate';
import { ChatPane } from './components/ChatPane';
import { InteractionTracePanel } from './components/InteractionTracePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { establishWebSession, exchangeWebCredential } from './auth';

let startupAuthentication: Promise<boolean> | null = null;

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<ExecutionTimeline | null>(null);
  const [trace, setTrace] = useState<InteractionTrace | null>(null);
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
      setSessionId(null);
      setConnected(false);
      setAuthError('Web 会话已失效。请重新启动 Web 或输入 --no-open 显示的 token。');
    };
    const http = new HttpClient(handleUnauthorized);
    httpRef.current = http;
    const ws = new WsClient({
      onHello: sid => setSessionId(sid),
      onOutput: (lines, from) => setOutput(prev => mergeOutputLines(prev, from, lines)),
      onExecution: (_taskId, next) => setTimeline(next),
      onTraceSnapshot: next => setTrace(next),
      onTraceDelta: (turnId, fromSequence, events) => {
        setTrace(current => {
          if (!current || current.turnId !== turnId) return current;
          const expected = (current.events.at(-1)?.sequence ?? 0) + 1;
          if (fromSequence > expected) return current;
          const merged = new Map(current.events.map(event => [event.id, event]));
          for (const event of events) merged.set(event.id, event);
          const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
          const last = ordered.at(-1);
          const status = last?.kind === 'delivery_completed'
            ? 'completed'
            : last?.status === 'failed'
              ? 'failed'
              : last?.status === 'blocked'
                ? 'blocked'
                : current.status;
          return {
            ...current,
            status,
            completedAt: status === 'running' ? null : last?.occurredAt ?? current.completedAt,
            events: ordered,
          };
        });
      },
      onError: message => setOutput(prev => [...prev, `错误: ${message}`]),
      onUnauthorized: handleUnauthorized,
      onStatusChange: setConnected,
    });
    wsRef.current = ws;
    ws.connect();
    void http.getConfig()
      .then(snapshot => setRevisionId(snapshot.runningRevisionId))
      .catch(() => undefined);
    return () => ws.close();
  }, [authenticated]);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="dot" data-connected={connected} />
          <span className="brand">AnyFusion</span>
          {sessionId && <span className="session-id">{sessionId}</span>}
        </div>
        <div className="topbar-right">
          <span className="revision">rev {revisionId ?? '…'}</span>
          <button className="ghost-button" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>
      <div className="main">
        <ChatPane output={output} onSend={text => wsRef.current?.sendInput(text)} />
        <InteractionTracePanel trace={trace} timeline={timeline} />
      </div>
      {settingsOpen && (
        <SettingsPanel http={httpRef.current} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
