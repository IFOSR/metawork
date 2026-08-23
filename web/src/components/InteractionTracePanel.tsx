import { useEffect, useRef, useState } from 'react';
import type {
  ExecutionTimeline,
  InteractionTrace,
  InteractionTraceEvent,
} from '../api/types';
import { MarkdownContent } from './MarkdownContent';

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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastSequence = trace?.events.at(-1)?.sequence ?? 0;
  const activeEventId = trace?.status === 'running'
    ? [...trace.events].reverse().find(event => event.status === 'running')?.id
    : undefined;

  useEffect(() => {
    if (trace?.status === 'running') {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [lastSequence, trace?.status]);

  useEffect(() => {
    if (trace?.status !== 'running') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [trace?.status, trace?.turnId]);

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
          {trace?.status === 'running' ? ` · ${formatDuration(nowMs - Date.parse(trace.startedAt))}` : ''}
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
              <li
                className="interaction-event"
                key={event.id}
                data-status={
                  event.status === 'running' && event.id !== activeEventId
                    ? 'completed'
                    : event.status
                }
              >
                <div className="event-rail"><span /></div>
                <article>
                  <div className="event-meta">
                    <span>{PHASE_LABEL[event.phase]}</span>
                    <span>{ACTOR_LABEL[event.actor]}</span>
                    <time>{formatTime(event.occurredAt)}</time>
                  </div>
                  <h3>{event.title}</h3>
                  <div className={event.kind === 'kernel_decision'
                    && event.details.action === 'request_clarification'
                    ? 'clarification-card'
                    : 'event-summary'}>
                    {event.kind === 'kernel_decision'
                      && event.details.action === 'request_clarification' && (
                        <span className="clarification-label">需要补充信息</span>
                      )}
                    <MarkdownContent value={event.summary} />
                  </div>
                  {event.id === activeEventId && (
                    <span className="event-elapsed">
                      当前阶段 {formatDuration(nowMs - Date.parse(event.occurredAt))}
                    </span>
                  )}
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
                <small key={index}>
                  {attempt.result}
                  {attempt.progress?.text ? ` · ${String(attempt.progress.text)}` : ''}
                  {attempt.error ? ` · ${attempt.error}` : ''}
                </small>
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
        <div><dt>授权绑定</dt><dd>{formatValue(authorizedBinding)}</dd></div>
      )}
      {Object.entries(details).filter(([key]) => key !== 'authorizedBinding').map(([key, value]) => (
        <div key={key}><dt>{formatKey(key)}</dt><dd>{formatValue(value)}</dd></div>
      ))}
    </dl>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function formatKey(key: string): string {
  return ({
    decisionId: '决策 ID',
    action: '动作',
    eventId: '事件 ID',
    configurationRevision: '配置 revision',
    question: '澄清问题',
    subtaskId: 'Subtask ID',
    fallbackOrder: '回退顺序',
    routingRole: '路由角色',
  } as Record<string, string>)[key] ?? key;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs < 0) return '0秒';
  const totalSeconds = Math.floor(valueMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}分${totalSeconds % 60}秒`;
}
