import type { ConversationTurnProjection } from '../api/session-types';

export function TrajectorySummary({ turn }: { turn: ConversationTurnProjection }) {
  const events = turn.traceEvents;
  const duration = Math.max(
    0,
    Date.parse(turn.completedAt ?? events.at(-1)?.occurredAt ?? turn.startedAt)
      - Date.parse(turn.startedAt),
  );
  const tools = events.filter(event => event.kind.includes('tool_')).length;
  const cycles = events.filter(event => event.kind === 'planner_turn_started').length;
  const attempts = turn.executionTimeline?.stages
    .flatMap(stage => stage.subtasks ?? [])
    .reduce((total, subtask) => total + subtask.attempts.length, 0) ?? 0;
  return (
    <section className="trajectory-summary">
      <Metric label="总耗时" value={formatDuration(duration)} />
      <Metric label="Planner 轮次" value={String(cycles)} />
      <Metric label="工具调用" value={String(tools)} />
      <Metric label="Kernel 决策" value={String(events.filter(event => event.actor === 'kernel').length)} />
      <Metric label="Executor 尝试" value={String(attempts)} />
      <Metric label="状态" value={turn.status.toUpperCase()} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0s';
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}
