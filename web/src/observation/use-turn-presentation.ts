import { useEffect, useState } from 'react';
import type { ConversationTurnView } from '../../../src/session/conversation-read-types';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import type { ConversationTurnProjection, TurnBillUserView } from '../api/session-types';

type Presentation = Pick<ConversationTurnProjection, 'traceEvents' | 'executionTimeline' | 'artifacts' | 'turnBilling'>;
interface TaskResource {
  targetConversationId: string; turnId: string; taskId: string;
  timeline: ConversationTurnProjection['executionTimeline'];
  artifacts: ConversationTurnProjection['artifacts'];
}
const EMPTY: Presentation = { traceEvents: [], executionTimeline: null, artifacts: [], turnBilling: null };
// These are disposable resource responses, not a second reducer for shared facts.
const caches = new WeakMap<WsClient, Map<string, Presentation>>();
const queues = new WeakMap<WsClient, { active: number; waiting: Array<() => void> }>();
async function schedule(ws: WsClient, current: () => boolean, work: () => Promise<void>) {
  let queue = queues.get(ws);
  if (!queue) { queue = { active: 0, waiting: [] }; queues.set(ws, queue); }
  if (queue.active >= 4) {
    if (queue.waiting.length >= 128) return;
    await new Promise<void>(resolve => queue!.waiting.push(resolve));
  } else queue.active++;
  try { if (current()) await work(); }
  finally {
    const next = queue.waiting.shift();
    if (next) next();
    else queue.active--;
  }
}
function cacheFor(ws: WsClient) {
  let cache = caches.get(ws);
  if (!cache) { cache = new Map(); caches.set(ws, cache); }
  return cache;
}
function remember(ws: WsClient, key: string, value: Presentation) {
  const cache = cacheFor(ws);
  cache.delete(key);
  if (new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024) cache.set(key, value);
  while (cache.size > 32) cache.delete(cache.keys().next().value!);
}

/** Hydrate the existing cards for mounted Turns without delaying text or replaying history. */
export function useTurnPresentation(ws: WsClient, http: HttpClient, conversationId: string,
  turn: ConversationTurnView | undefined, showExecution: boolean) {
  const generation = ws.conversations.currentGeneration();
  const key = `${generation}\0${conversationId}\0${turn?.id ?? ''}\0${turn?.taskId ?? ''}`;
  const [state, setState] = useState<{ key: string; value: Presentation }>(() => ({ key, value: cacheFor(ws).get(key) ?? EMPTY }));
  useEffect(() => {
    if (!turn) return;
    let active = true;
    let busy = false;
    let refreshAgain = false;
    const current = () => active && generation === ws.conversations.currentGeneration();
    let value = cacheFor(ws).get(key) ?? EMPTY;
    setState({ key, value });
    const commit = (patch: Partial<Presentation>) => {
      if (!current()) return;
      const next = { ...value, ...patch };
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      value = next; remember(ws, key, value); setState({ key, value });
    };
    const refresh = async () => {
      if (!current()) return;
      if (busy) { refreshAgain = true; return; }
      busy = true;
      await schedule(ws, current, async () => {
        // Independent resources: missing billing must not suppress execution/artifacts.
        const jobs: Promise<unknown>[] = [];
        if (showExecution) jobs.push(http.getConversationTrace(conversationId, turn.id, undefined, true)
          .then(page => commit({ traceEvents: page.events })));
        if (turn.taskId) jobs.push(ws.query<TaskResource>(conversationId,
          { kind: 'get_task_view', conversationId, turnId: turn.id, taskId: turn.taskId }).then(task => {
          if (task.targetConversationId !== conversationId || task.turnId !== turn.id || task.taskId !== turn.taskId) return;
          commit({ executionTimeline: task.timeline, artifacts: task.artifacts });
        }));
        if (turn.interactionKind !== 'system_command') jobs.push(ws.query<{ turnId: string; turnBill: TurnBillUserView }>(conversationId,
          { kind: 'get_query_bill_for_turn', turnId: turn.id }).then(result => {
          if (result.turnId === turn.id && result.turnBill?.turnId === turn.id
            && result.turnBill.conversationId === conversationId) commit({ turnBilling: result.turnBill });
        }));
        await Promise.allSettled(jobs);
      });
      busy = false;
      if (refreshAgain && current()) { refreshAgain = false; void refresh(); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), turn.status === 'running' || turn.status === 'blocked' ? 1_000 : 5_000);
    // Terminal/result changes refresh immediately; the timer also catches late metering and publication.
    const unsubscribe = ws.conversations.subscribeTurn(conversationId, turn.id, () => void refresh());
    const revoke = ws.conversations.onRevoked(id => {
      if (id !== conversationId) return;
      active = false; caches.delete(ws); setState({ key, value: EMPTY });
    });
    return () => { active = false; clearInterval(timer); unsubscribe(); revoke(); };
  }, [ws, http, key, generation, conversationId, turn?.id, turn?.taskId, turn?.status, showExecution]);
  return state.key === key ? state.value : cacheFor(ws).get(key) ?? EMPTY;
}
