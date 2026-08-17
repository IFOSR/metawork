import type { ConversationTurnProjection } from '../api/session-types';

const PHASES = ['intake', 'planning', 'authorization', 'routing', 'execution', 'verification', 'delivery'] as const;

export function TrajectoryTimeline({ turn }: { turn: ConversationTurnProjection }) {
  const start = Date.parse(turn.startedAt);
  const end = Date.parse(turn.completedAt ?? turn.traceEvents.at(-1)?.occurredAt ?? turn.startedAt);
  const duration = Math.max(1, end - start);
  return (
    <section className="trajectory-band">
      <div className="trajectory-band-labels">
        <span>0s</span><strong>PHASE TIMELINE</strong><span>{(duration / 1_000).toFixed(1)}s</span>
      </div>
      <div className="trajectory-track">
        {PHASES.map(phase => {
          const events = turn.traceEvents.filter(event => event.phase === phase);
          if (events.length === 0) return null;
          const phaseStart = Date.parse(events[0]!.occurredAt);
          const phaseEnd = Date.parse(events.at(-1)!.occurredAt);
          return (
            <span
              className="trajectory-segment"
              data-phase={phase}
              key={phase}
              style={{
                left: `${((phaseStart - start) / duration) * 100}%`,
                width: `${Math.max(2, ((phaseEnd - phaseStart + 30) / duration) * 100)}%`,
              }}
              title={phase}
            />
          );
        })}
      </div>
    </section>
  );
}
