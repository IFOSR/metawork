import { useEffect, useRef } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';
import type { ExecutionTimeline, InteractionTraceEvent } from '../api/types';

const KIND_LABELS: Record<string, string> = {
  executor_routed: '路由',
  executor_dispatch_authorized: '派发授权',
  executor_dispatch_started: '启动',
  subtask_execution_started: '开始执行',
  executor_progress: '进度',
  executor_heartbeat: '心跳',
  executor_result_observed: '校验',
  publication_integrated: '发布',
  delivery_completed: '交付',
};

/**
 * Executor 执行详情抽屉：按时间线实时呈现一个 Subtask 的全部安全执行事件
 * （叙述摘要、工具活动、里程碑）。数据来自现有 InteractionTrace 流，
 * WebSocket trace_delta 到达时自动追加并滚到底部。
 */
export function ExecutionDetailDrawer({
  turn,
  subtaskId,
  onClose,
}: {
  turn: ConversationTurnProjection;
  subtaskId: string;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const events = collectDetailEvents(turn.traceEvents, turn.executionTimeline, subtaskId);
  const meta = latestExecutionMeta(turn.traceEvents, turn.executionTimeline, subtaskId);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [events.length, subtaskId]);

  return (
    <aside className="execution-detail-drawer" data-testid="execution-detail-drawer">
      <header className="execution-detail-header">
        <div className="execution-detail-title">
          <span>EXECUTOR DETAIL</span>
          <strong>{meta?.subtaskTitle || subtaskId}</strong>
          <small>
            {[
              meta?.executorDisplayName,
              meta?.providerDisplayName,
              meta?.modelDisplayName,
            ].filter(Boolean).join(' · ') || '等待 Executor 绑定…'}
          </small>
        </div>
        <button
          type="button"
          className="execution-detail-close"
          onClick={onClose}
          aria-label="关闭执行详情"
          title="关闭（Esc）"
        >
          ✕
        </button>
      </header>
      <div className="execution-detail-body" ref={bodyRef}>
        {events.length === 0 && (
          <div className="execution-detail-empty">等待第一个执行事件…</div>
        )}
        <ol className="execution-detail-stream">
          {events.map(event => (
            <li key={event.id} data-kind={event.kind} data-status={event.status}>
              <time>{formatClock(event.occurredAt)}</time>
              <div className="execution-detail-entry">
                <span className="execution-detail-kind">
                  {KIND_LABELS[event.kind] ?? event.kind}
                </span>
                <p className="execution-detail-summary">{event.summary || event.title}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

interface ExecutionMeta {
  subtaskTitle: string;
  executorDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
}

function latestExecutionMeta(
  events: InteractionTraceEvent[],
  timeline: ExecutionTimeline | null,
  subtaskId: string,
): ExecutionMeta | null {
  let meta: ExecutionMeta | null = null;
  for (const event of events) {
    const details = event.details as Record<string, unknown> | undefined;
    if (!details || details.subtaskId !== subtaskId) continue;
    meta = {
      subtaskTitle: readString(details.subtaskTitle) || meta?.subtaskTitle || subtaskId,
      executorDisplayName: readString(details.executorDisplayName)
        || readString(details.executorName)
        || meta?.executorDisplayName
        || '',
      providerDisplayName: readString(details.providerDisplayName) || meta?.providerDisplayName || '',
      modelDisplayName: readString(details.modelDisplayName) || meta?.modelDisplayName || '',
    };
  }
  const durableSubtask = timeline?.stages
    .find(stage => stage.phase === 'execution')
    ?.subtasks?.find(subtask => subtask.id === subtaskId);
  if (durableSubtask) {
    meta = {
      subtaskTitle: meta?.subtaskTitle || durableSubtask.title,
      executorDisplayName: meta?.executorDisplayName || durableSubtask.executor || '',
      providerDisplayName: meta?.providerDisplayName || '',
      modelDisplayName: meta?.modelDisplayName || '',
    };
  }
  return meta;
}

function collectDetailEvents(
  traceEvents: InteractionTraceEvent[],
  timeline: ExecutionTimeline | null,
  subtaskId: string,
): InteractionTraceEvent[] {
  const events = traceEvents.filter(event => {
    const details = event.details as Record<string, unknown> | undefined;
    return event.subtaskId === subtaskId
      || (Boolean(details) && details?.subtaskId === subtaskId);
  });
  const knownProgress = new Set(events.map(event => (
    `${event.attemptId ?? String(event.details.attemptId ?? '')}:${event.occurredAt}:${event.summary}`
  )));
  const durableEvents: InteractionTraceEvent[] = [];
  const subtask = timeline?.stages
    .find(stage => stage.phase === 'execution')
    ?.subtasks?.find(item => item.id === subtaskId);
  for (const attempt of subtask?.attempts ?? []) {
    for (const [index, progress] of (attempt.progressHistory ?? []).entries()) {
      const key = `${attempt.attemptId ?? ''}:${progress.occurredAt}:${progress.text}`;
      if (knownProgress.has(key)) continue;
      durableEvents.push({
        id: `durable:${attempt.attemptId ?? subtaskId}:${index}:${progress.occurredAt}`,
        cursor: `durable:${attempt.attemptId ?? subtaskId}:${index}`,
        eventKey: `${attempt.attemptId ?? subtaskId}:${index}`,
        taskId: timeline?.taskId ?? null,
        subtaskId,
        attemptId: attempt.attemptId ?? null,
        sequence: 1_000_000 + index,
        occurredAt: progress.occurredAt,
        phase: 'execution',
        actor: 'executor',
        kind: progress.kind === 'heartbeat' ? 'executor_heartbeat' : 'executor_progress',
        status: 'running',
        title: progress.kind === 'heartbeat' ? 'Executor 心跳' : 'Executor 进度',
        summary: progress.text,
        details: {
          subtaskId,
          attemptId: attempt.attemptId ?? null,
          stepLabel: progress.text,
          durable: true,
        },
      });
    }
  }
  return [...events, ...durableEvents]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
      || left.sequence - right.sequence
      || left.id.localeCompare(right.id));
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
