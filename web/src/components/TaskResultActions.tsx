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
      <p><span className="fact-key">执行模式</span>{modeLabel(delivery.mode)}（{sourceLabel(delivery.modeSource)}）</p>
      {delivery.mode === 'worktree' && (
        <p><span className="fact-key">候选状态</span>{candidateLabel(delivery.candidate)}</p>
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
      {delivery.conflicts.length > 0 && (
        <p role="alert">{delivery.mode === 'in_place' ? '未登记文件' : '请处理冲突文件后继续'}：{delivery.conflicts.join('、')}</p>
      )}
    </div>}
  </section>;
}

function modeLabel(mode: 'in_place' | 'worktree'): string {
  return mode === 'in_place' ? 'In-place（目标工作区就地执行）' : 'Worktree（隔离执行，授权后发布）';
}

function sourceLabel(source: 'explicit_user' | 'planner' | 'fallback' | 'kernel_safety' | null): string {
  switch (source) {
    case 'explicit_user': return '用户明确要求';
    case 'planner': return 'Planner 判断';
    case 'fallback': return '高级设置默认';
    case 'kernel_safety': return 'Kernel 安全规则';
    default: return '未知来源';
  }
}

function candidateLabel(candidate: 'none' | 'executing' | 'awaiting_acceptance' | 'conflict' | 'published' | 'cleaned'): string {
  switch (candidate) {
    case 'executing': return '隔离执行中，目标工作区未改变';
    case 'awaiting_acceptance': return '候选已生成，等待你接受后发布';
    case 'conflict': return '发布冲突，需要处理后继续';
    case 'published': return '已发布到目标工作区';
    case 'cleaned': return '隔离执行目录已清理';
    default: return '尚无候选变更';
  }
}
