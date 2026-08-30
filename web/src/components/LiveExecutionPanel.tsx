import { useEffect, useState } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';
import type { ExecutionTimeline, InteractionTraceEvent } from '../api/types';
import { executionElapsedEndMs } from '../execution-duration';

interface ExecutionCard {
  subtaskId: string;
  subtaskTitle: string;
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
  stepLabel: string;
  stepKey: string;
  progress: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  activityStatus: string;
}

/**
 * 当前执行卡片：把安全的 InteractionTrace 里程碑按 Subtask 分组展示，
 * 显示 Executor/Harness/Provider/Model 与当前步骤。多 Subtask 并发时
 * 各卡片互不串线。完成后由调用方折叠为执行摘要。
 * 卡片可点击：打开该 Subtask 的 Executor 执行详情抽屉（实时事件流）。
 */
export function LiveExecutionPanel({
  turn,
  onSelectSubtask,
}: {
  turn: ConversationTurnProjection;
  onSelectSubtask?: (subtaskId: string, subtaskTitle: string) => void;
}) {
  const [, setNowMs] = useState(() => Date.now());
  const completed = turn.status !== 'running';

  useEffect(() => {
    if (completed) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.id, completed]);

  const cards = collectExecutionCards(turn.traceEvents, turn.executionTimeline);
  if (cards.length === 0) return null;

  return (
    <section className={`live-execution-panel${completed ? ' is-summary' : ''}`} aria-label="执行状态">
      <header>
        <span>{completed ? 'EXECUTION SUMMARY' : 'LIVE EXECUTION'}</span>
        {!completed && <em data-pulse aria-hidden />}
      </header>
      <div className="live-execution-cards">
        {cards.map(card => (
          onSelectSubtask ? (
            <button
              type="button"
              className="execution-card is-clickable"
              data-status={completed ? 'settled' : 'running'}
              onClick={() => onSelectSubtask(card.subtaskId, card.subtaskTitle)}
              title="查看 Executor 执行详情"
              key={card.subtaskId}
            >
              <CardBody card={card} completed={completed} />
            </button>
          ) : (
            <article
              className="execution-card"
              data-status={completed ? 'settled' : 'running'}
              key={card.subtaskId}
            >
              <CardBody card={card} completed={completed} />
            </article>
          )
        ))}
      </div>
    </section>
  );
}

function CardBody({ card, completed }: { card: ExecutionCard; completed: boolean }) {
  return (
    <>
      <h4 title={card.subtaskTitle}>{card.subtaskTitle}</h4>
      <dl>
        <dt>Executor</dt><dd>{card.executorDisplayName || '—'}</dd>
        <dt>Harness</dt><dd>{card.harnessDisplayName || '—'}</dd>
        <dt>Provider</dt><dd>{card.providerDisplayName || '—'}</dd>
        <dt>Model</dt><dd>{card.modelDisplayName || '—'}</dd>
      </dl>
      <p className="execution-card-step" data-activity={card.activityStatus}>
        {activityLabel(card.activityStatus, card.stepLabel)}
      </p>
      <footer>
        <time>{formatElapsed(
          card.startedAt,
          executionElapsedEndMs(
            !completed && isActiveActivity(card.activityStatus),
            card.updatedAt,
            Date.now(),
          ),
        )}</time>
        {completed
          ? <span className="execution-card-open-hint">查看执行详情 →</span>
          : card.progress !== null && <progress value={Math.min(1, card.progress)} max={1} />}
      </footer>
    </>
  );
}

function collectExecutionCards(
  events: InteractionTraceEvent[],
  timeline: ExecutionTimeline | null,
): ExecutionCard[] {
  const bySubtask = new Map<string, ExecutionCard>();
  const executionStage = timeline?.stages.find(stage => stage.phase === 'execution');
  for (const subtask of executionStage?.subtasks ?? []) {
    const attempt = subtask.attempts.at(-1);
    const latest = attempt?.progressHistory?.at(-1);
    bySubtask.set(subtask.id, {
      subtaskId: subtask.id,
      subtaskTitle: subtask.title,
      executorDisplayName: subtask.executor || '',
      harnessDisplayName: '',
      providerDisplayName: '',
      modelDisplayName: '',
      stepLabel: latest?.text || 'Executor 已启动，等待公开进度…',
      stepKey: latest?.kind || 'executor_waiting',
      progress: null,
      startedAt: attempt?.startedAt ?? null,
      updatedAt: attempt?.updatedAt ?? null,
      activityStatus: attempt?.status ?? attempt?.result ?? subtask.status,
    });
  }
  for (const event of events) {
    const details = event.details as Record<string, unknown>;
    if (!details || typeof details !== 'object') continue;
    const subtaskId = event.subtaskId || readString(details.subtaskId);
    if (!subtaskId) continue;
    const existing = bySubtask.get(subtaskId) ?? {
      subtaskId,
      subtaskTitle: '',
      executorDisplayName: '',
      harnessDisplayName: '',
      providerDisplayName: '',
      modelDisplayName: '',
      stepLabel: '',
      stepKey: '',
      progress: null as number | null,
      startedAt: null as string | null,
      updatedAt: null as string | null,
      activityStatus: event.kind,
    };
    // 事件按 sequence 有序，后到的事实覆盖先到的字段。
    const next: ExecutionCard = {
      ...existing,
      subtaskTitle: readString(details.subtaskTitle) || existing.subtaskTitle || subtaskId,
      executorDisplayName: readString(details.executorDisplayName)
        || readString(details.executorName)
        || existing.executorDisplayName,
      harnessDisplayName: readString(details.harnessDisplayName) || existing.harnessDisplayName,
      providerDisplayName: readString(details.providerDisplayName) || existing.providerDisplayName,
      modelDisplayName: readString(details.modelDisplayName) || existing.modelDisplayName,
      stepKey: readString(details.stepKey) || existing.stepKey,
      stepLabel: readString(details.stepLabel) || event.title || existing.stepLabel,
      progress: typeof details.progress === 'number' && Number.isFinite(details.progress)
        ? details.progress
        : existing.progress,
      startedAt: typeof details.startedAt === 'string'
        ? details.startedAt
        : existing.startedAt ?? event.occurredAt,
      updatedAt: typeof details.updatedAt === 'string'
        ? details.updatedAt
        : event.occurredAt,
      activityStatus: activityStatusFor(event),
    };
    bySubtask.set(subtaskId, next);
  }
  return [...bySubtask.values()];
}

function activityStatusFor(event: InteractionTraceEvent): string {
  if (event.kind === 'executor_heartbeat') return 'heartbeat';
  if (event.kind === 'dependency_wait') return 'dependency_wait';
  if (event.kind === 'capacity_wait') return 'capacity_wait';
  if (event.kind.includes('blocked') || event.status === 'blocked') return 'blocked';
  return event.status === 'running' ? 'active' : event.status;
}

function isActiveActivity(status: string): boolean {
  return ['active', 'running', 'heartbeat', 'dependency_wait', 'capacity_wait'].includes(status);
}

function activityLabel(status: string, step: string): string {
  if (status === 'heartbeat') return `运行中（心跳）：${step}`;
  if (status === 'dependency_wait') return `等待依赖：${step}`;
  if (status === 'capacity_wait') return `等待容量：${step}`;
  if (status === 'blocked') return `已阻塞：${step}`;
  return step;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function formatElapsed(start: string | null, nowMs: number): string {
  if (!start) return '';
  const parsed = Date.parse(start);
  if (Number.isNaN(parsed)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
