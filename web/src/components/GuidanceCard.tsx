import { useState } from 'react';
import type { GuidanceBlock } from '../guidance-block';
import { normalizeGuidanceAction, shortTaskId } from '../guidance-block';

/**
 * Structured replacement for the ASCII guidance box.
 * Reading order: what to do → which task → why, with the raw scene name demoted
 * to a quiet chip because it is machine vocabulary, not user language.
 */
export function GuidanceCard({ block }: { block: GuidanceBlock }) {
  const [copied, setCopied] = useState(false);
  const label = block.kind === 'proposal' ? '操作提案' : '操作指引';
  const action = normalizeGuidanceAction(block.action, block.target);
  const copyTaskId = (): void => {
    if (!block.target?.taskId) return;
    void navigator.clipboard?.writeText(block.target.taskId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  return (
    <section className="guidance-card" data-kind={block.kind} aria-label={label}>
      <header className="guidance-card-head">
        <span className="guidance-card-label">{label}</span>
        {block.scene && <span className="guidance-card-scene" title="内部场景标识">{block.scene}</span>}
      </header>
      {action && <p className="guidance-card-action">{action}</p>}
      {block.target && (
        <p className="guidance-card-task">
          <span className="guidance-card-task-title">{block.target.title}</span>
          {block.target.taskId && (
            <button
              type="button"
              className="guidance-card-id"
              title={`${block.target.taskId}（点击复制完整 ID）`}
              onClick={copyTaskId}
            >
              {shortTaskId(block.target.taskId)}
            </button>
          )}
          <span className="guidance-card-copied" role="status" aria-live="polite">{copied ? '已复制' : ''}</span>
        </p>
      )}
      {block.reasons.length > 0 && (
        <ul className="guidance-card-reasons">
          {block.reasons.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      {block.confidence !== null && (
        <footer className="guidance-card-meta">
          <span>置信度 {block.confidence.toFixed(2)}</span>
          {block.policy && <span>{block.policy}</span>}
        </footer>
      )}
    </section>
  );
}
