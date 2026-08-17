import { useEffect, useRef } from 'react';
import type {
  ExecutionTimeline,
  InteractionTrace,
  InteractionTraceEvent,
} from '../api/types';

const PHASE_LABEL: Record<InteractionTraceEvent['phase'], string> = {
  intake: '接收',
  planning: '规划',
  authorization: '授权',
  routing: '路由',
  execution: '执行',
  verification: '验证',
  delivery: '交付',
};

const ACTOR_LABEL: Record<InteractionTraceEvent['actor'], string> = {
  user: '用户',
  planner: 'Planner',
  kernel: 'Kernel',
  runtime: 'Runtime',
  executor: 'Executor',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '进行中',
  completed: '完成',
  failed: '失败',
  blocked: '阻塞',
};

export function InteractionTracePanel({
  trace,
  timeline,
}: {
  trace: InteractionTrace | null;
  timeline: ExecutionTimeline | null;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const lastSequence = trace?.events.at(-1)?.sequence ?? 0;

  useEffect(() => {
    if (trace?.status === 'running') {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [lastSequence, trace?.status]);

  return (
    <aside
      className="interaction-trace-pane"
      ref={scrollRef}
      data-streaming={trace?.status === 'running'}
    >
      <header className="interaction-trace-header">
        <div>
          <span className="eyebrow">AUDITABLE PROCESS</span>
          <h2>执行逻辑</h2>
        </div>
        <span className="trace-status-badge" data-status={trace?.status ?? 'pending'}>
          {STATUS_LABEL[trace?.status ?? 'pending']}
        </span>
      </header>

      {!trace && !timeline && <div className="empty-hint">提交问题后，这里会流式展示完整执行流程。</div>}

      {trace && (
        <>
          <div className="trace-query">
            <span>当前请求</span>
            <strong>{trace.events.find(event => event.kind === 'query_received')?.summary}</strong>
            <small>{trace.taskId ? `Task ${trace.taskId}` : trace.turnId}</small>
          </div>
          <ol className="interaction-events">
            {trace.events.map(event => (
              <li className="interaction-event" key={event.id} data-status={event.status}>
                <div className="event-rail"><span /></div>
                <article>
                  <div className="event-meta">
                    <span>{PHASE_LABEL[event.phase]}</span>
                    <span>{ACTOR_LABEL[event.actor]}</span>
                    <time>{formatTime(event.occurredAt)}</time>
                  </div>
                  <h3>{event.title}</h3>
                  <p>{event.summary}</p>
                  {Object.keys(event.details).length > 0 && (
                    <details>
                      <summary>查看结构化详情</summary>
                      <DetailGrid details={event.details} />
                    </details>
                  )}
                </article>
              </li>
            ))}
          </ol>
        </>
      )}

      {timeline?.stages.some(stage => stage.subtasks?.length) && (
        <section className="durable-execution">
          <span className="eyebrow">DURABLE EXECUTION</span>
          <h3>Executor 与验证</h3>
          {timeline.stages.flatMap(stage => stage.subtasks ?? []).map(subtask => (
            <div className="executor-card" key={subtask.id}>
              <div><strong>{subtask.executor ?? 'Executor'}</strong><span>{subtask.status}</span></div>
              <p>{subtask.title}</p>
              {subtask.attempts.map((attempt, index) => (
                <small key={index}>{attempt.result}{attempt.error ? ` · ${attempt.error}` : ''}</small>
              ))}
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}

function DetailGrid({ details }: { details: Record<string, unknown> }) {
  const authorizedBinding = details.authorizedBinding;
  return (
    <dl className="detail-grid">
      {authorizedBinding !== undefined && (
        <><dt>authorizedBinding</dt><dd>{formatValue(authorizedBinding)}</dd></>
      )}
      {Object.entries(details).filter(([key]) => key !== 'authorizedBinding').map(([key, value]) => (
        <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>
      ))}
    </dl>
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
