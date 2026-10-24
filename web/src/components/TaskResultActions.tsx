import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';

/**
 * Delivery facts only. The accept/retry decision is rendered once, in the
 * "需要你的处理才能继续" card above, so the user never sees two button rows that
 * claim to be the same next step.
 */
export function TaskResultActions({ delivery }: {
  delivery?: GatewayTaskViewSnapshot['publicDelivery'];
}) {
  if (!delivery) return null;
  return <section className="task-result-actions" aria-label="任务交付">
    {delivery && <div className="task-result-facts" data-mode={delivery.mode}>
      <p><span className="fact-key">Workspace</span>{delivery.workspace}</p>
      {delivery.taskDirectory && (
        <p><span className="fact-key">任务目录</span>{delivery.taskDirectory}</p>
      )}
      <p data-state={delivery.state}>
        <span className="fact-key">{delivery.mode === 'in_place' ? '工作区文件' : '代码状态'}</span>
        {/* Server-resolved sentence: in-place rounds report file changes, not publishing. */}
        {delivery.stateLabel}
      </p>
      {delivery.files.length > 0 && (
        <details>
          <summary>{delivery.mode === 'in_place' ? '本轮更新文件' : '交付文件'}（{delivery.files.length}）</summary>
          <ul>{delivery.files.map(file => <li key={file}>{file}</li>)}</ul>
        </details>
      )}
      {delivery.legacy && delivery.files.length > 0 && (
        <p className="fact-legacy">这是历史发布副本（只读）：旧版本把交付文件复制到任务目录，新任务改为在工作区就地更新。</p>
      )}
      {delivery.conflicts.length > 0 && (
        <p role="alert">{delivery.mode === 'in_place' ? '未登记文件' : '请处理冲突文件后继续'}：{delivery.conflicts.join('、')}</p>
      )}
    </div>}
  </section>;
}
