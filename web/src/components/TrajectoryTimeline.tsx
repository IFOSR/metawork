import type { ConversationTurnProjection } from '../api/session-types';

const PHASES = ['intake', 'planning', 'authorization', 'routing', 'execution', 'verification', 'delivery'] as const;

export function TrajectoryTimeline({ turn }: { turn: ConversationTurnProjection }) {
  const firstEventMs = parseTime(turn.traceEvents[0]?.occurredAt);
  const lastEventMs = parseTime(turn.traceEvents.at(-1)?.occurredAt);
  const start = parseTime(turn.startedAt) ?? firstEventMs;
  const end = parseTime(turn.completedAt) ?? lastEventMs;
  // A missing end time is not a zero-duration phase: without a measured end
  // the band reports that no duration is known instead of inventing 0s or a
  // minimum 1ms.
  const duration = start !== null && end !== null && end >= start ? end - start : null;
  return (
    <section className="trajectory-band">
      <div className="trajectory-band-labels">
        <span>0s</span><strong>PHASE TIMELINE</strong>
        <span>{duration === null ? '—' : formatDuration(duration)}</span>
      </div>
      <div className="trajectory-track">
        {duration === null ? null : PHASES.map(phase => {
          const events = turn.traceEvents.filter(event => event.phase === phase);
          if (events.length === 0) return null;
          const phaseStart = parseTime(events[0]!.occurredAt);
          const phaseEnd = parseTime(events.at(-1)!.occurredAt);
          if (phaseStart === null || phaseEnd === null) return null;
          const span = Math.max(0, phaseEnd - phaseStart);
          // A phase of zero measured width still gets a visible marker; that is
          // a rendering minimum, not a claim about how long the phase took.
          return (
            <span
              className="trajectory-segment"
              data-phase={phase}
              key={phase}
              style={{
                left: `${clampPercent(((phaseStart - start!) / duration) * 100)}%`,
                width: `${clampPercent(Math.max(0.5, ((span + (duration > 0 ? 30 : 0)) / duration) * 100))}%`,
              }}
              title={phase}
            />
          );
        })}
      </div>
    </section>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return '<1s';
  return `${(ms / 1_000).toFixed(1)}s`;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
