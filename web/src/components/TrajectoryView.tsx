import type { ConversationTurnProjection } from '../api/session-types';
import { TrajectoryEventTable } from './TrajectoryEventTable';
import { TrajectorySummary } from './TrajectorySummary';
import { TrajectoryTimeline } from './TrajectoryTimeline';
import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WorkGraphPresentationProjection } from '../api/types';
import { WorkGraphPanel } from './WorkGraphPanel';

export function TrajectoryView({ turn, http }: { turn: ConversationTurnProjection | null; http?: HttpClient | null }) {
  const [workGraph, setWorkGraph] = useState<WorkGraphPresentationProjection | null>(null);
  useEffect(() => {
    if (!http || !turn?.taskId) {
      setWorkGraph(null);
      return;
    }
    let cancelled = false;
    void http.getTaskWorkGraph(turn.taskId)
      .then(projection => { if (!cancelled) setWorkGraph(projection); })
      .catch(() => { if (!cancelled) setWorkGraph(null); });
    return () => { cancelled = true; };
  }, [http, turn?.taskId, turn?.status, turn?.traceEvents.length]);
  if (!turn) {
    return <div className="workspace-empty"><h2>暂无轨迹</h2><p>提交请求后可查看完整事件时间线。</p></div>;
  }
  return (
    <div className="trajectory-view">
      <TrajectorySummary turn={turn} />
      <WorkGraphPanel projection={workGraph} />
      <TrajectoryTimeline turn={turn} />
      <TrajectoryEventTable turn={turn} />
    </div>
  );
}
