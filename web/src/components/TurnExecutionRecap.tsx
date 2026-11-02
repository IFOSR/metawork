import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { WorkGraphPresentationProjection } from '../api/types';
import { WorkGraphPanel } from './WorkGraphPanel';

/**
 * A finished Turn keeps its execution plan.
 *
 * The live execution panel only narrates work in progress, so a completed Turn
 * used to lose its DAG entirely once the next Turn started. Audit and recall
 * both need the historical graph, and it is immutable data: the projection reads
 * the authorize decision and Subtask rows of that Turn's own Task, never the
 * conversation's newest Task.
 *
 * The graph is fetched only when the reader expands the section, so reopening a
 * long conversation costs no extra requests.
 */
export function TurnExecutionRecap({
  taskId,
  http,
  statusLabel,
}: {
  taskId: string;
  http: HttpClient | null;
  /** Task conclusion for this Turn, shown before the graph is loaded. */
  statusLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [projection, setProjection] = useState<WorkGraphPresentationProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !http || projection || error) return;
    let active = true;
    void http.getTaskWorkGraph(taskId)
      .then(value => { if (active) setProjection(value); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [open, http, projection, error, taskId]);

  return (
    <section className="turn-execution-recap" aria-label="历史执行计划">
      <button
        type="button"
        className="turn-execution-recap-toggle"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span className="eyebrow">EXECUTION RECORD</span>
        <strong>执行计划与子任务</strong>
        <small>{statusLabel}</small>
        <span aria-hidden>{open ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      {open && (error
        ? <p role="alert">无法读取该轮次的执行计划：{error}</p>
        : projection
          ? <WorkGraphPanel projection={projection} />
          : <p className="turn-execution-recap-loading">正在读取该轮次的执行计划…</p>)}
    </section>
  );
}
