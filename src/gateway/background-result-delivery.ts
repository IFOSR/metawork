import type { Task } from '../core/types.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import type { ConversationTurn, WebSessionRecord } from '../management/web-session-types.js';
import type { QueryUsageContext } from '../metering/ports.js';
import type { ExecutionTimeline } from '../management/execution-projector.js';
import type { GatewayReplay } from './client-events.js';

export interface BackgroundResultDeliveryDeps {
  readonly accountId: string;
  resolveTask(resultId: string): Task | null;
  resolveQuery(taskId: string): QueryUsageContext | null;
  taskForQuery(queryId: string): string | null;
  read(conversationId: string): Promise<WebSessionRecord | null>;
  requestText(taskId: string): string | null;
  project(task: Task): ExecutionTimeline;
  append(conversationId: string, turn: ConversationTurn): Promise<unknown>;
  replay(conversationId: string): Promise<GatewayReplay>;
  publish(input: {
    conversationId: string; turnId: string; requestId: string;
    delivery: ConversationResultDelivery; backgroundWorkPending: boolean;
    originTurnId?: string;
  }): Promise<void>;
}

/** System execution has no foreground Session; use durable ownership, never the selected Turn. */
export function createBackgroundResultDelivery(deps: BackgroundResultDeliveryDeps) {
  const tails = new Map<string, Promise<void>>();
  const deliver = async (sessionId: string, delivery: ConversationResultDelivery, originTurnId?: string): Promise<void> => {
    const task = deps.resolveTask(delivery.resultId);
    if (!task || task.accountId !== deps.accountId || task.conversationId !== sessionId) return;
    const query = deps.resolveQuery(task.id);
    if (!query?.turnId || query.conversationId !== sessionId || query.accountId !== task.accountId
      || deps.taskForQuery(query.queryId) !== task.id) return;
    const replay = await deps.replay(sessionId);
    const alreadyDelivered = [...replay.snapshot, ...replay.deltas].some(event => (
      event.turnId === query.turnId && event.kind === 'result_completed'
      && (event.payload as { resultId?: string } | null)?.resultId === delivery.resultId
    ));
    const old = (await deps.read(sessionId))?.turns.find(turn => turn.id === query.turnId);
    const userInput = old?.userInput ?? deps.requestText(task.id);
    if (!userInput) return;
    const backgroundWorkPending = ['created', 'ready', 'running'].includes(task.status);
    // Store the answer before publishing, including when the original client disconnected.
    if (old?.finalAnswer !== delivery.content) await deps.append(sessionId, {
      id: query.turnId, sessionId, userInput, interactionKind: 'ai_turn',
      status: task.status === 'blocked' ? 'blocked' : task.status === 'cancelled' ? 'cancelled' : 'completed',
      deliveryStatus: 'ready',
      finalAnswer: delivery.content, taskId: task.id,
      startedAt: old?.startedAt ?? query.acceptedAt,
      completedAt: backgroundWorkPending ? null : task.updatedAt,
      traceEvents: old?.traceEvents ?? [], executionTimeline: deps.project(task),
      artifactRefs: old?.artifactRefs ?? [], artifacts: old?.artifacts ?? [],
    });
    if (!alreadyDelivered) await deps.publish({
      conversationId: sessionId, turnId: query.turnId, requestId: query.requestId,
      delivery, backgroundWorkPending,
      ...(originTurnId ? { originTurnId } : {}),
    });
  };
  return (sessionId: string, delivery: ConversationResultDelivery, originTurnId?: string): Promise<void> => {
    const work = (tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => deliver(sessionId, delivery, originTurnId));
    tails.set(sessionId, work);
    return work.finally(() => { if (tails.get(sessionId) === work) tails.delete(sessionId); });
  };
}
