import { useDeferredValue, useState } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';

export function TrajectoryEventTable({ turn }: { turn: ConversationTurnProjection }) {
  const [query, setQuery] = useState('');
  const [actorFilter, setActorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [phaseFilter, setPhaseFilter] = useState('all');
  const deferredQuery = useDeferredValue(query.toLocaleLowerCase());
  const events = turn.traceEvents.filter(event => (
    (actorFilter === 'all' || event.actor === actorFilter)
    && (statusFilter === 'all' || event.status === statusFilter)
    && (phaseFilter === 'all' || event.phase === phaseFilter)
    && `${event.title} ${event.summary} ${event.kind}`.toLocaleLowerCase().includes(deferredQuery)
  ));
  return (
    <section className="trajectory-table-wrap">
      <div className="trajectory-filters">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事件" />
        <Filter value={phaseFilter} onChange={setPhaseFilter} values={['all', 'planning', 'authorization', 'routing', 'execution', 'verification', 'delivery']} />
        <Filter value={actorFilter} onChange={setActorFilter} values={['all', 'planner', 'kernel', 'runtime', 'executor']} />
        <Filter value={statusFilter} onChange={setStatusFilter} values={['all', 'running', 'completed', 'failed', 'blocked']} />
      </div>
      <div className="trajectory-table">
        <div className="trajectory-row trajectory-head">
          <span>#</span><span>Actor</span><span>Event</span><span>Summary</span><span>Status</span><span>Time</span>
        </div>
        {events.map(event => (
          <details className="trajectory-event" key={event.id}>
            <summary className="trajectory-row">
              <span>{event.sequence}</span>
              <span className="actor-chip">{event.actor}</span>
              <strong>{event.title}</strong>
              <span>{event.summary}</span>
              <span data-status={event.status}>{event.status}</span>
              <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
            </summary>
            <pre>{JSON.stringify(event.details, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}

function Filter({
  value,
  values,
  onChange,
}: {
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={event => onChange(event.target.value)}>
      {values.map(item => <option value={item} key={item}>{item}</option>)}
    </select>
  );
}
