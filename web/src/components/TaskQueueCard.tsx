import type { TaskQueueBlock } from '../task-queue';
import { shortTaskId } from '../guidance-block';

/** Reading order: what happened, then the queue with state and reason per row. */
export function TaskQueueCard({ block }: { block: TaskQueueBlock }) {
  return (
    <section className="task-queue-card" aria-label="任务队列">
      <header className="task-queue-head">
        <span className="task-queue-label">任务队列</span>
        {block.overview.map(entry => (
          <span key={entry.label} className="task-queue-count" data-zero={entry.count === 0}>
            {entry.label} {entry.count}
          </span>
        ))}
      </header>
      {block.trigger && <p className="task-queue-trigger">触发：{block.trigger}</p>}
      <ol className="task-queue-list">
        {block.items.map(item => (
          <li key={item.taskId} data-state={item.state}>
            <span className="task-queue-state">{item.state}</span>
            <span className="task-queue-title">{item.title}</span>
            <code className="task-queue-id" title={item.taskId}>{shortTaskId(item.taskId)}</code>
            {item.meta.length > 0 && <span className="task-queue-meta">{item.meta.join(' · ')}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
