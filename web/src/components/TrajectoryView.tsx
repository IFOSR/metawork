import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { TrajectoryEventTable } from './TrajectoryEventTable';
import { TrajectorySummary } from './TrajectorySummary';
import { TrajectoryTimeline } from './TrajectoryTimeline';
import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WorkGraphPresentationProjection } from '../api/types';
import { WorkGraphPanel } from './WorkGraphPanel';
import { LiveExecutionPanel } from './LiveExecutionPanel';
import { ArtifactLink } from './ArtifactLink';

export function TrajectoryView({
  turn,
  http,
  onOpenArtifact,
  onOpenSubtaskDetail,
}: {
  turn: ConversationTurnProjection | null;
  http?: HttpClient | null;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenSubtaskDetail?: (subtaskId: string, subtaskTitle: string) => void;
}) {
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
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  return (
    <div className="trajectory-view">
      {turn && (
        <LiveExecutionPanel turn={turn} onSelectSubtask={onOpenSubtaskDetail} />
      )}
      <TrajectorySummary turn={turn} />
      <WorkGraphPanel projection={workGraph} />
      <TrajectoryTimeline turn={turn} />
      <TrajectoryEventTable turn={turn} />
      {onOpenArtifact && artifacts.length > 0 && (
        <section className="turn-artifacts" aria-label="任务产物">
          <header><span>ARTIFACTS</span></header>
          <div className="artifact-link-list">
            {artifacts.map(artifact => (
              <ArtifactLink
                artifact={artifact}
                onOpen={() => onOpenArtifact(artifact)}
                key={artifact.artifactId}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
