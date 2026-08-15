import { useEffect, useRef, useState } from 'react';
import { HttpClient } from './api/http';
import { WsClient } from './api/ws';
import type { ExecutionTimeline } from './api/types';
import { TokenGate } from './components/TokenGate';
import { ChatPane } from './components/ChatPane';
import { ExecutionTimelineView } from './components/ExecutionTimeline';
import { SettingsPanel } from './components/SettingsPanel';

const TOKEN_STORAGE_KEY = 'anyfusion.web.token';

export function App() {
  const [token, setToken] = useState<string | null>(() => {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? localStorage.getItem(TOKEN_STORAGE_KEY);
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<ExecutionTimeline | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const httpRef = useRef<HttpClient | null>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!token) return;

    const http = new HttpClient(token);
    httpRef.current = http;
    const ws = new WsClient(token, {
      onHello: sid => setSessionId(sid),
      onOutput: lines => setOutput(prev => [...prev, ...lines]),
      onExecution: (_taskId, next) => setTimeline(next),
      onError: message => setOutput(prev => [...prev, `错误: ${message}`]),
      onStatusChange: setConnected,
    });
    wsRef.current = ws;
    ws.connect();

    void http.getConfig().then(snapshot => setRevisionId(snapshot.revisionId)).catch(() => undefined);

    return () => {
      ws.close();
    };
  }, [token]);

  const handleAuth = (newToken: string, trust: boolean) => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    if (trust) localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    setToken(newToken);
  };

  const handleSend = (text: string) => {
    wsRef.current?.sendInput(text);
  };

  if (!token) {
    return <TokenGate onAuth={handleAuth} />;
  }

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
        <ChatPane output={output} onSend={handleSend} />
        <ExecutionTimelineView timeline={timeline} />
      </div>
      {settingsOpen && (
        <SettingsPanel http={httpRef.current} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
