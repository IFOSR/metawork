import type { ExecutionTimeline, SubtaskCard } from '../api/types';
import { DecisionDetail } from './DecisionDetail';
import { subtaskTitle, type WorkGraphTitleIndex } from '../work-graph-titles';

interface ExecutionTimelineViewProps {
  timeline: ExecutionTimeline | null;
  titleBySubtask?: WorkGraphTitleIndex;
}

const PHASE_LABEL: Record<string, string> = {
  planning: '规划',
  authorization: '授权',
  execution: '执行',
  verification: '验证',
  delivery: '交付',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待定',
  running: '进行中',
  done: '完成',
  failed: '失败',
  blocked: '需要处理',
  waiting: '等待中', executing: '执行中', needs_action: '需要处理', finished: '已结束',
};

export function ExecutionTimelineView({ timeline, titleBySubtask }: ExecutionTimelineViewProps) {
  if (!timeline) {
    return (
      <aside className="timeline-pane">
        <div className="empty-hint">暂无执行任务。</div>
      </aside>
    );
  }

  const proposalTitles = titleBySubtask && titleBySubtask.size > 0
    ? [...titleBySubtask.values()]
    : null;

  return (
    <aside className="timeline-pane">
      <div className="timeline-header">
        <span className="timeline-title">{timeline.title}</span>
        <span className="timeline-status" title={timeline.userStateReason}>{STATUS_LABEL[timeline.userState] ?? timeline.userState}</span>
      </div>
      <ol className="stages">
        {timeline.stages.map(stage => (
          <li className="stage" key={stage.phase} data-status={stage.status}>
            <div className="stage-head">
              <span className="stage-dot" />
              <span className="stage-name">{PHASE_LABEL[stage.phase] ?? stage.phase}</span>
              <span className="stage-status">{STATUS_LABEL[stage.status] ?? stage.status}</span>
            </div>

            {stage.proposal && (
              <div className="stage-body">
                <div className="stage-subtasks">
                  {(proposalTitles ?? stage.proposal.subtasks).map((subtask, index) => (
                    <div className="proposal-subtask" key={`${index}:${subtask}`}>{subtask}</div>
                  ))}
                </div>
              </div>
            )}

            {stage.decisions && stage.decisions.length > 0 && (
              <div className="stage-body">
                {stage.decisions.map((decision, index) => (
                  <DecisionDetail decision={decision} key={index} />
                ))}
              </div>
            )}

            {stage.subtasks && stage.subtasks.length > 0 && (
              <div className="stage-body">
                {stage.subtasks.map(subtask => (
                  <SubtaskRow subtask={subtask} titleBySubtask={titleBySubtask} key={subtask.id} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

function SubtaskRow({ subtask, titleBySubtask }: { subtask: SubtaskCard; titleBySubtask?: WorkGraphTitleIndex }) {
  return (
    <div className="subtask-row" data-status={subtask.status}>
      <span className="subtask-name">{subtaskTitle(titleBySubtask, subtask.id, subtask.title)}</span>
      {subtask.executor && <span className="subtask-executor">{subtask.executor}</span>}
      <span className="subtask-status">{STATUS_LABEL[subtask.status] ?? subtask.status}</span>
    </div>
  );
}
