import type { ConversationTurnProjection } from '../api/session-types';
import { ConversationTurnView } from './ConversationTurn';

export function ConversationView({ turns }: { turns: ConversationTurnProjection[] }) {
  if (turns.length === 0) {
    return (
      <div className="workspace-empty">
        <span>READY</span>
        <h2>从一个明确目标开始</h2>
        <p>Planner、Kernel 与 Executor 的安全执行步骤会按发生顺序显示在这里。</p>
      </div>
    );
  }
  return (
    <div className="conversation-view">
      {turns.map(turn => <ConversationTurnView turn={turn} key={turn.id} />)}
    </div>
  );
}
