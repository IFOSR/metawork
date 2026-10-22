import type { ArtifactProjection, ConversationTurnProjection } from '../api/session-types';
import { TrajectoryEventTable } from './TrajectoryEventTable';
import { TrajectorySummary } from './TrajectorySummary';
import { TrajectoryTimeline } from './TrajectoryTimeline';
import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WorkGraphPresentationProjection } from '../api/types';
import { WorkGraphPanel } from './WorkGraphPanel';
import { ExecutionNarrative } from './ExecutionNarrative';
import { LiveExecutionPanel } from './LiveExecutionPanel';
import { ArtifactLink } from './ArtifactLink';
import { workGraphTitleIndex } from '../work-graph-titles';

export function TrajectoryView({
  turn,
  http,
  onOpenArtifact,
  onOpenSubtaskDetail,
  onLoadMore,
  loading = false,
  hasMore = false,
}: {
  turn: ConversationTurnProjection | null;
  http?: HttpClient | null;
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
  onOpenSubtaskDetail?: (subtaskId: string, subtaskTitle: string) => void;
  onLoadMore?: () => void;
  loading?: boolean;
  hasMore?: boolean;
}) {
  const [workGraph, setWorkGraph] = useState<WorkGraphPresentationProjection | null>(null);
  const taskId = turn?.taskId ?? turn?.executionTimeline?.taskId ?? null;
  useEffect(() => {
    if (!http || !taskId) {
      setWorkGraph(null);
      return;
    }
    let cancelled = false;
    void http.getTaskWorkGraph(taskId)
      .then(projection => { if (!cancelled) setWorkGraph(projection); })
      .catch(() => { if (!cancelled) setWorkGraph(null); });
    return () => { cancelled = true; };
  }, [http, taskId, turn?.status, turn?.traceEvents.length]);
  if (!turn) {
    return <div className="workspace-empty"><h2>暂无轨迹</h2><p>提交请求后可查看完整事件时间线。</p></div>;
  }
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  const titleBySubtask = workGraphTitleIndex(workGraph);
  return (
    <div className="trajectory-view">
      {turn && (
        <LiveExecutionPanel turn={turn} onSelectSubtask={onOpenSubtaskDetail} workGraph={workGraph} />
      )}
      <TrajectorySummary turn={turn} />
      <ExecutionNarrative turn={turn} titleBySubtask={titleBySubtask} />
      <WorkGraphPanel projection={workGraph} />
      <TrajectoryTimeline turn={turn} />
      <TrajectoryEventTable
        turn={turn}
        onLoadMore={onLoadMore}
        loading={loading}
        hasMore={hasMore}
      />
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
