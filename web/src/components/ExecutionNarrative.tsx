import { useEffect, useState } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';
import type { InteractionTraceEvent } from '../api/types';
import { formatExecutionDuration } from '../execution-duration';
import { turnExecutionPresentation } from '../turn-execution-presentation';
import { ExecutionStep } from './ExecutionStep';
import { subtaskTitle, type WorkGraphTitleIndex } from '../work-graph-titles';

const GROUPS: Array<{
  title: string;
  phases: InteractionTraceEvent['phase'][];
}> = [
  { title: 'Planner', phases: ['intake', 'planning'] },
  { title: '授权与路由', phases: ['authorization', 'routing'] },
  { title: '执行', phases: ['execution'] },
  { title: '验证与交付', phases: ['verification', 'delivery'] },
];

export function ExecutionNarrative({ turn, titleBySubtask }: {
  turn: ConversationTurnProjection;
  titleBySubtask?: WorkGraphTitleIndex;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState(true);
  const activeEvent = turn.status === 'running'
    ? [...turn.traceEvents].reverse().find(event => event.status === 'running')
    : undefined;

  useEffect(() => {
    if (turn.status !== 'running') return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.id, turn.status]);

  useEffect(() => {
    setCollapsed(true);
  }, [turn.id]);

  return (
    <section className="execution-narrative" data-collapsed={collapsed || undefined}>
      <header>
        <div className="narrative-header-main">
          <span>EXECUTION NARRATIVE</span>
          <strong data-status={turn.status}>{turnExecutionPresentation(turn).label || '—'}</strong>
        </div>
        <button
          type="button"
          className="narrative-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? '展开' : '折叠'}
        </button>
      </header>
      {!collapsed && GROUPS.map(group => {
        const events = turn.traceEvents.filter(event => group.phases.includes(event.phase));
        const stage = turn.executionTimeline?.stages.find(item => (
          group.phases.includes(item.phase as InteractionTraceEvent['phase'])
        ));
        const progressSteps = stage?.subtasks?.reduce(
          (total, subtask) => total + subtask.attempts.reduce(
            (attemptTotal, attempt) => attemptTotal + Math.max(
              1,
              attempt.progressHistory?.length ?? 0,
            ),
            0,
          ),
          0,
        ) ?? 0;
        const hasStageContent = Boolean(
          stage?.proposal
          || stage?.decisions?.length
          || stage?.subtasks?.some(subtask => subtask.attempts.length > 0),
        );
        if (events.length === 0 && !hasStageContent) return null;
        return (
          <section className="narrative-group" key={group.title}>
            <div className="narrative-group-title">
              <h3>{group.title}</h3>
              <span>{events.length + progressSteps
                + (stage?.proposal ? 1 : 0)
                + (stage?.decisions?.length ?? 0)} steps</span>
            </div>
            {stage?.proposal && (
              <div className="narrative-stage-fact">
                <strong>Planner 已形成执行提案</strong>
                <span>{stage.proposal.subtasks.length} 个子任务，{stage.proposal.dependencies.length} 条依赖</span>
              </div>
            )}
            {stage?.decisions?.map((decision, index) => (
              <div className="narrative-stage-fact" key={`${decision.type}:${decision.subtask}:${index}`}>
                <strong>Kernel · {decision.type}</strong>
                <span>{decision.reason || decision.subtask || '已记录授权决策'}</span>
              </div>
            ))}
            {events.map(event => (
              <ExecutionStep event={event} active={event.id === activeEvent?.id} key={event.id} />
            ))}
            {stage?.subtasks?.map(subtask => (
              <div className="executor-subtask" key={subtask.id}>
                <div className="subtask-fact">
                  <span>{subtask.status}</span>
                  <strong>{subtaskTitle(titleBySubtask, subtask.id, subtask.title)}</strong>
                  <small>{subtask.executor ?? '等待 Executor 绑定'}</small>
                </div>
                {subtask.attempts.map(attempt => {
                  const history = attempt.progressHistory ?? [];
                  const latestText = typeof attempt.progress?.text === 'string'
                    ? attempt.progress.text
                    : null;
                  return (
                    <div
                      className="executor-attempt"
                      data-status={attempt.status ?? attempt.result}
                      key={attempt.attemptId ?? attempt.result}
                    >
                      <header>
                        <span className="executor-attempt-label" title={attempt.attemptLabel}>
                          {attempt.attemptLabel}
                        </span>
                        <strong className="executor-attempt-status">{attempt.displayStatus}</strong>
                        <time className="executor-attempt-duration">
                          {formatExecutionDuration({
                            executionStartedAt: attempt.executionStartedAt,
                            executionCompletedAt: attempt.executionCompletedAt,
                            updatedAt: attempt.updatedAt,
                            running: attempt.displayStatus === '执行中',
                            nowMs,
                          })}
                        </time>
                      </header>
                      <ol>
                        {history.map((entry, index) => (
                          <li key={`${entry.occurredAt}:${index}`}>
                            <time>{formatClock(entry.occurredAt)}</time>
                            <span>{entry.text}</span>
                          </li>
                        ))}
                        {history.length === 0 && (
                          <li className="executor-waiting">
                            <time>LIVE</time>
                            <span>{latestText ?? 'Executor 已启动，等待第一个可公开的执行进度事件…'}</span>
                          </li>
                        )}
                      </ol>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
