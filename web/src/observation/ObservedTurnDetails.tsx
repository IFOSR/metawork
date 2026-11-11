import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import type { InteractionTraceEvent, WorkGraphPresentationProjection } from '../api/types';
import { useConversationTurn } from './use-conversation';
import { useLocatedTurn } from './use-located-turn';
import { turnProjection } from './turn-projection';
import { TrajectoryView } from '../components/TrajectoryView';
import { TrajectoryTurnRail } from '../components/TrajectoryTurnRail';
import { ExecutionDetailDrawer } from '../components/ExecutionDetailDrawer';
import { useTurnPresentation } from './use-turn-presentation';

export function ObservedExecutionDetail({ conversationId, initial, subtaskId, fallbackTitle, ws, http, onClose }: {
  conversationId: string; initial: ConversationTurnProjection; subtaskId: string; fallbackTitle?: string;
  ws: WsClient; http: HttpClient; onClose(): void;
}) {
  const summary = useConversationTurn(ws.conversations, conversationId, initial.id);
  const located = useLocatedTurn(http, conversationId, initial.id, summary);
  // The drawer addresses one Turn by id: a Turn that left the store window is
  // read from the server so its graph and progress stay reachable.
  const resolved = located.turn ?? summary ?? null;
  const details = useTurnPresentation(ws, http, conversationId, resolved ?? undefined, true);
  const [workGraph, setWorkGraph] = useState<WorkGraphPresentationProjection | null>(null);
  useEffect(() => {
    const taskId = resolved?.taskId ?? initial.taskId;
    if (!taskId) { setWorkGraph(null); return; }
    let active = true;
    void http.getTaskWorkGraph(taskId).then(value => { if (active) setWorkGraph(value); })
      .catch(() => { if (active) setWorkGraph(null); });
    return () => { active = false; };
  }, [http, resolved?.taskId, initial.taskId]);
  return <ExecutionDetailDrawer turn={resolved ? { ...turnProjection(resolved), ...details } : initial}
    subtaskId={subtaskId} fallbackTitle={fallbackTitle} workGraph={workGraph} onClose={onClose} />;
}

/** Separate, bounded detail requests never block the Conversation baseline. */
export function ObservedTurnDetails({ conversationId, turnId, ws, http, tab, onSelectTurn, onOpenArtifact, onOpenSubtaskDetail }: {
  conversationId: string; turnId: string; ws: WsClient; http: HttpClient; tab: 'trajectory';
  /** Switch which Turn this surface reads; history must stay reachable. */
  onSelectTurn?: (turnId: string) => void;
  onOpenArtifact(artifact: ArtifactProjection): void;
  onOpenSubtaskDetail(turn: ConversationTurnProjection, subtaskId: string): void;
}) {
  const liveSummary = useConversationTurn(ws.conversations, conversationId, turnId);
  const located = useLocatedTurn(http, conversationId, turnId, liveSummary);
  const summary = located.turn ?? liveSummary;
  const detail = useTurnPresentation(ws, http, conversationId, summary ?? undefined, true);
  const generation = ws.conversations.currentGeneration();
  const [trace, setTrace] = useState<InteractionTraceEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const historyPage = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    let active = true;
    const current = () => active && ws.conversations.currentGeneration() === generation;
    setTrace([]); setCursor(null); setError(null);
    historyPage.current = false;
    const ticket = ++lifetime.current;
    let busy = false;
    const refresh = async () => {
      if (busy || !current()) return;
      busy = true;
      try {
        if (!historyPage.current) {
          const page = await http.getConversationTrace(conversationId, turnId);
          if (current() && !historyPage.current) { setTrace(page.events); setCursor(page.nextCursor); }
        }
      } catch (error) { if (current()) setError((error as Error).message); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => { active = false; clearInterval(timer); if (lifetime.current === ticket) lifetime.current++; };
  }, [conversationId, turnId, generation, tab, ws, http]);
  if (!summary) {
    // A Turn outside the bounded store window is read from the server instead
    // of leaving this surface stuck on a loading line forever.
    return located.error
      ? <p role="alert">无法读取该轮次：{located.error}</p>
      : <p>正在读取轮次…</p>;
  }
  const turn = { ...turnProjection(summary), ...detail, traceEvents: trace };
  const loadMore = () => {
    if (!cursor || loading) return;
    const generation = ws.conversations.currentGeneration();
    const ticket = lifetime.current;
    historyPage.current = true;
    setLoading(true);
    void http.getConversationTrace(conversationId, turnId, cursor).then(page => {
      if (generation !== ws.conversations.currentGeneration() || ticket !== lifetime.current) return;
      setTrace(previous => [...previous, ...page.events]);
      setCursor(page.nextCursor);
    }).catch(error => { if (ticket === lifetime.current) setError((error as Error).message); })
      .finally(() => { if (ticket === lifetime.current) setLoading(false); });
  };
  return <>
    {tab === 'trajectory' && onSelectTurn && (
      <TrajectoryTurnRail
        conversationId={conversationId}
        ws={ws}
        http={http}
        selectedTurnId={turnId}
        onSelectTurn={onSelectTurn}
      />
    )}
    {error && <p role="alert">{error}</p>}
    {<TrajectoryView turn={turn} executionTraceEvents={detail.traceEvents} http={http} onOpenArtifact={onOpenArtifact}
          onOpenSubtaskDetail={subtaskId => onOpenSubtaskDetail(turn, subtaskId)}
          onLoadMore={tab === 'trajectory' ? loadMore : undefined}
          loading={tab === 'trajectory' && loading}
          hasMore={tab === 'trajectory' && Boolean(cursor)} />}
  </>;
}
