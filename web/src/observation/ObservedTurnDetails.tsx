import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import type { ArtifactProjection, ConversationTurnProjection, QueryBillProjection } from '../api/session-types';
import type { InteractionTraceEvent } from '../api/types';
import { useConversationTurn } from './use-conversation';
import { turnProjection } from './turn-projection';
import { TrajectoryView } from '../components/TrajectoryView';
import { BillingView } from '../components/BillingView';
import { ExecutionDetailDrawer } from '../components/ExecutionDetailDrawer';
import { useTurnPresentation } from './use-turn-presentation';

export function ObservedExecutionDetail({ conversationId, initial, subtaskId, ws, http, onClose }: {
  conversationId: string; initial: ConversationTurnProjection; subtaskId: string;
  ws: WsClient; http: HttpClient; onClose(): void;
}) {
  const summary = useConversationTurn(ws.conversations, conversationId, initial.id);
  const details = useTurnPresentation(ws, http, conversationId, summary, true);
  return <ExecutionDetailDrawer turn={summary ? { ...turnProjection(summary), ...details } : initial}
    subtaskId={subtaskId} onClose={onClose} />;
}

/** Separate, bounded detail requests never block the Conversation baseline. */
export function ObservedTurnDetails({ conversationId, turnId, ws, http, tab, onOpenArtifact, onOpenSubtaskDetail }: {
  conversationId: string; turnId: string; ws: WsClient; http: HttpClient; tab: 'trajectory' | 'billing';
  onOpenArtifact(artifact: ArtifactProjection): void;
  onOpenSubtaskDetail(turn: ConversationTurnProjection, subtaskId: string): void;
}) {
  const summary = useConversationTurn(ws.conversations, conversationId, turnId);
  const [detail, setDetail] = useState<Partial<ConversationTurnProjection>>({});
  const [trace, setTrace] = useState<InteractionTraceEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const historyPage = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    let active = true;
    const generation = ws.conversations.currentGeneration();
    const current = () => active && ws.conversations.currentGeneration() === generation;
    setDetail({}); setTrace([]); setCursor(null); setError(null);
    historyPage.current = false;
    const ticket = ++lifetime.current;
    let busy = false;
    const refresh = async () => {
      if (busy || !current()) return;
      busy = true;
      try {
        if (tab === 'billing') {
          const value = await ws.query<{ turnBill?: { queryId: string | null; headline: string } }>(conversationId,
            { kind: 'get_query_bill_for_turn', turnId });
          if (!current()) return;
          if (!value.turnBill?.queryId) { setError(value.turnBill?.headline ?? null); return; }
          const bill = await ws.query<QueryBillProjection>(conversationId, { kind: 'get_query_bill', queryId: value.turnBill.queryId });
          if (current()) { setDetail({ queryBill: bill }); setError(null); }
        } else {
          if (!historyPage.current) {
            const page = await http.getConversationTrace(conversationId, turnId);
            if (current() && !historyPage.current) { setTrace(page.events); setCursor(page.nextCursor); }
          }
          if (summary?.taskId) {
            const value = await ws.query<{
              targetConversationId: string; turnId: string; taskId: string;
              timeline: ConversationTurnProjection['executionTimeline']; artifacts: ArtifactProjection[];
            }>(conversationId, { kind: 'get_task_view', conversationId, turnId, taskId: summary.taskId });
            if (current() && value.targetConversationId === conversationId && value.turnId === turnId && value.taskId === summary.taskId) {
              setDetail({ executionTimeline: value.timeline, artifacts: value.artifacts }); setError(null);
            }
          }
        }
      } catch (error) { if (current()) setError((error as Error).message); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => { active = false; clearInterval(timer); if (lifetime.current === ticket) lifetime.current++; };
  }, [conversationId, turnId, summary?.taskId, tab, ws, http]);
  if (!summary) return <p>正在读取轮次…</p>;
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
    {error && <p role="alert">{error}</p>}
    {tab === 'billing' ? <BillingView bill={turn.queryBill ?? null} requestSummary={turn.userInput} />
      : <TrajectoryView turn={turn} http={http} onOpenArtifact={onOpenArtifact}
          onOpenSubtaskDetail={subtaskId => onOpenSubtaskDetail(turn, subtaskId)}
          onLoadMore={tab === 'trajectory' ? loadMore : undefined}
          loading={tab === 'trajectory' && loading}
          hasMore={tab === 'trajectory' && Boolean(cursor)} />}
  </>;
}
