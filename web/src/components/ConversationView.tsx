import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { ConversationTurnView } from './ConversationTurn';
import { LiveExecutionPanel } from './LiveExecutionPanel';

export function ConversationView({
  turns,
  running = false,
  onOpenArtifact,
  onOpenSubtaskDetail,
}: {
  turns: ConversationTurnProjection[];
  running?: boolean;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenSubtaskDetail?: (subtaskId: string, subtaskTitle: string) => void;
}) {
  if (turns.length === 0) {
    return (
      <div className="workspace-empty">
        <span>READY</span>
        <h2>从一个明确目标开始</h2>
        <p>Planner、Kernel 与 Executor 的安全执行步骤会按发生顺序显示在这里。</p>
      </div>
    );
  }
  const latest = turns.at(-1);
  return (
    <div className="conversation-view">
      {latest && (
        <LiveExecutionPanel turn={latest} onSelectSubtask={onOpenSubtaskDetail} />
      )}
      {turns.map(turn => (
        <ConversationTurnView turn={turn} key={turn.id} onOpenArtifact={onOpenArtifact} />
      ))}
    </div>
  );
}
