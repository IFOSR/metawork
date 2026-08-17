import type { ConversationTurnProjection } from '../api/session-types';
import type { InteractionTraceEvent } from '../api/types';
import { ExecutionStep } from './ExecutionStep';

const GROUPS: Array<{
  title: string;
  phases: InteractionTraceEvent['phase'][];
}> = [
  { title: 'Planner', phases: ['intake', 'planning'] },
  { title: '授权与路由', phases: ['authorization', 'routing'] },
  { title: '执行', phases: ['execution'] },
  { title: '验证与交付', phases: ['verification', 'delivery'] },
];

export function ExecutionNarrative({ turn }: { turn: ConversationTurnProjection }) {
  const activeEvent = turn.status === 'running'
    ? [...turn.traceEvents].reverse().find(event => event.status === 'running')
    : undefined;
  return (
    <section className="execution-narrative">
      <header>
        <span>EXECUTION NARRATIVE</span>
        <strong data-status={turn.status}>{statusLabel(turn.status)}</strong>
      </header>
      {GROUPS.map(group => {
        const events = turn.traceEvents.filter(event => group.phases.includes(event.phase));
        const stage = turn.executionTimeline?.stages.find(item => (
          group.phases.includes(item.phase as InteractionTraceEvent['phase'])
        ));
        if (events.length === 0 && !stage) return null;
        return (
          <section className="narrative-group" key={group.title}>
            <div className="narrative-group-title">
              <h3>{group.title}</h3>
              <span>{events.length} steps</span>
            </div>
            {events.map(event => (
              <ExecutionStep event={event} active={event.id === activeEvent?.id} key={event.id} />
            ))}
            {stage?.subtasks?.map(subtask => (
              <div className="subtask-fact" key={subtask.id}>
                <span>{subtask.status}</span>
                <strong>{subtask.title}</strong>
                <small>{subtask.executor ?? '等待 Executor 绑定'}</small>
              </div>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function statusLabel(status: ConversationTurnProjection['status']): string {
  return {
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    blocked: '阻塞',
  }[status];
}
