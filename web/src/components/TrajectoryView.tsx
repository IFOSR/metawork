import type { ConversationTurnProjection } from '../api/session-types';
import { TrajectoryEventTable } from './TrajectoryEventTable';
import { TrajectorySummary } from './TrajectorySummary';
import { TrajectoryTimeline } from './TrajectoryTimeline';

export function TrajectoryView({ turn }: { turn: ConversationTurnProjection | null }) {
  if (!turn) {
    return <div className="workspace-empty"><h2>暂无轨迹</h2><p>提交请求后可查看完整事件时间线。</p></div>;
  }
  return (
    <div className="trajectory-view">
      <TrajectorySummary turn={turn} />
      <TrajectoryTimeline turn={turn} />
      <TrajectoryEventTable turn={turn} />
    </div>
  );
}
