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
        <p><span className="fact-key">目标项目目录</span>{delivery.taskDirectory}</p>
      )}
      <p><span className="fact-key">执行方式</span>目标 Workspace 就地执行（{sourceLabel(delivery.modeSource)}）</p>
      <p data-state={delivery.state}>
        <span className="fact-key">工作区文件</span>
        {delivery.stateLabel}
      </p>
      {delivery.files.length > 0 && (
        <details>
          <summary>本轮更新文件（{delivery.files.length}）</summary>
          <ul>{delivery.files.map(file => <li key={file}>{file}</li>)}</ul>
        </details>
      )}
      {delivery.conflicts.length > 0 && (
        <p role="alert">未登记文件：{delivery.conflicts.join('、')}</p>
      )}
    </div>}
  </section>;
}
function sourceLabel(source: 'explicit_user' | 'planner' | 'fallback' | 'kernel_safety' | null): string {
  switch (source) {
    case 'explicit_user': return '用户明确要求';
    case 'planner': return 'Planner 判断';
    case 'fallback': return '系统默认规则';
    case 'kernel_safety': return 'Kernel 规则';
    default: return '未知来源';
  }
}
