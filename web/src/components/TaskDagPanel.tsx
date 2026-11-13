import { useEffect, useMemo, useState } from 'react';
import type { ConversationTurnProjection } from '../api/session-types';
import type { WorkGraphPresentationProjection } from '../api/types';
import type { HttpClient } from '../api/http';
import { collectExecutionCards, taskDagNodeDetails, taskDagSummary } from '../task-dag';
import { workGraphNodeLabel } from '../work-graph-layout';
import { WorkGraphDiagram } from './WorkGraphDiagram';

/**
 * The Task's one DAG view in the conversation.
 *
 * It replaces the retired execution cards: the same derivation (`task-dag.ts`)
 * supplies each node's executor/model, current step and elapsed time, and a
 * click opens the existing execution-detail drawer for that Subtask. Live and
 * settled Turns render the same graph; only the header wording changes.
 */
export function TaskDagPanel({
  turn,
  http,
  workGraph,
  onSelectSubtask,
}: {
  turn: ConversationTurnProjection;
  http?: HttpClient | null;
  /** Preloaded projection; when absent the panel reads it for the Turn's Task. */
  workGraph?: WorkGraphPresentationProjection | null;
  onSelectSubtask?: (subtaskId: string, subtaskTitle: string) => void;
}) {
  const taskId = turn.taskId ?? turn.executionTimeline?.taskId ?? null;
  const live = turn.status === 'running' || turn.status === 'blocked';
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loaded, setLoaded] = useState<WorkGraphPresentationProjection | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const projection = workGraph !== undefined ? workGraph : loaded;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (workGraph !== undefined) return;
    if (!http || !taskId) { setLoaded(null); return; }
    let cancelled = false;
    setLoadFailed(false);
    void http.getTaskWorkGraph(taskId)
      .then(value => { if (!cancelled) setLoaded(value); })
      .catch(() => { if (!cancelled) { setLoaded(null); setLoadFailed(true); } });
    return () => { cancelled = true; };
  }, [http, taskId, turn.status, turn.traceEvents.length, workGraph]);

  const cards = useMemo(
    () => collectExecutionCards(turn.traceEvents, turn.executionTimeline, projection),
    [turn.traceEvents, turn.executionTimeline, projection],
  );
  const details = useMemo(() => taskDagNodeDetails(cards, nowMs, !live), [cards, nowMs, live]);
  const summary = taskDagSummary({
    cards,
    subtaskCount: projection?.nodes.length ?? 0,
    turnStatus: turn.status,
    artifactCount: turn.artifacts?.length ?? 0,
  });

  if (!taskId) {
    if (!live || turn.interactionKind === 'system_command' || turn.userInput.trim().startsWith('/')) return null;
    return (
      <section className="task-dag-panel" aria-label="任务执行图">
        <p className="task-dag-placeholder">Manager 正在规划这一步要做的事，任务拆解出来后这里会显示执行图。</p>
      </section>
    );
  }
  if (!projection) {
    return (
      <section className="task-dag-panel" aria-label="任务执行图">
        <p className="task-dag-placeholder">{loadFailed
          ? '暂时没有可显示的执行子任务图，请查看下方任务状态与处理结果。'
          : '正在读取执行计划…'}</p>
      </section>
    );
  }
  if (projection.nodes.length === 0) {
    return (
      <section className="task-dag-panel" aria-label="任务执行图">
        <p className="task-dag-placeholder">本任务只处理已有成果的交付或服务启动，没有新的执行子任务。请查看任务状态与处理结果。</p>
      </section>
    );
  }
  const activeId = projection.nodes.find(node => node.id === selectedId)?.id
    ?? projection.nodes.find(node => details.get(node.id)?.statusLabel === '执行中')?.id
    ?? projection.nodes.find(node => node.runnable)?.id
    ?? projection.nodes[0]!.id;

  return (
    <section className="task-dag-panel" aria-label="任务执行图">
      <header className="task-dag-header">
        <div>
          <span className="eyebrow">TASK DAG</span>
          <h3 data-state={summary.state}>{summary.headline}</h3>
          <p>{summary.detail}</p>
        </div>
        <span className="task-dag-count">{projection.nodes.length} 个子任务</span>
      </header>
      <WorkGraphDiagram
        projection={projection}
        selectedId={activeId}
        nodeDetail={id => details.get(id) ?? null}
        onSelect={id => {
          setSelectedId(id);
          const node = projection.nodes.find(item => item.id === id);
          if (node && onSelectSubtask) onSelectSubtask(node.id, workGraphNodeLabel(node));
        }}
      />
      <small className="task-dag-hint">点击节点查看该子任务的执行详情；箭头表示依赖方向。</small>
    </section>
  );
}
