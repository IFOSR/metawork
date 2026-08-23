import type { InteractionTraceEvent } from '../api/types';
import { MarkdownContent } from './MarkdownContent';

const ACTOR: Record<InteractionTraceEvent['actor'], string> = {
  user: 'USER',
  planner: 'PLANNER',
  kernel: 'KERNEL',
  runtime: 'RUNTIME',
  executor: 'EXECUTOR',
};

export function ExecutionStep({
  event,
  active,
}: {
  event: InteractionTraceEvent;
  active: boolean;
}) {
  return (
    <details className="execution-step" data-status={event.status} open={active}>
      <summary>
        <span className="step-status" />
        <span className="step-actor">{ACTOR[event.actor]}</span>
        <span className="step-copy">
          <strong>{event.title}</strong>
          <small>{event.summary}</small>
        </span>
        <time>{formatTime(event.occurredAt)}</time>
      </summary>
      <div className="step-body">
        <MarkdownContent value={event.summary} />
      </div>
      {Object.keys(event.details).length > 0 && (
        <dl className="step-details">
          {Object.entries(event.details).map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>
          ))}
        </dl>
      )}
    </details>
  );
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
