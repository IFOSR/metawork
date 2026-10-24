import { useState } from 'react';
import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';
import type { WsClient } from '../api/ws';

export function TaskResultActions({ ws, conversationId, lifecycle, delivery, refresh }: {
  refresh(): void;
  ws: WsClient;
  conversationId: string;
  taskId?: string | null;
  lifecycle?: GatewayTaskViewSnapshot['lifecycle'];
  delivery?: GatewayTaskViewSnapshot['publicDelivery'];
  pendingPermission?: GatewayTaskViewSnapshot['pendingPermission'];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const decision = lifecycle?.pendingDecision;
  const expectedResult = decision?.expectedResult;
  const act = async (kind: 'accept_task_result' | 'retry_task_attempt') => {
    if (!expectedResult || busy) return;
    setBusy(true); setMessage('正在提交，请稍候…');
    try {
      const result = await ws.control(conversationId, { kind, expectedResult }, () => {});
      setMessage(result.status === 'rejected' ? result.reason ?? '结果操作已过期，请等待任务刷新后重试。'
        : '操作已提交，任务状态正在刷新。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败，请刷新任务后重试。');
    } finally { refresh(); setBusy(false); }
  };
  if (!expectedResult && !delivery) return null;
  return <section className="task-result-actions" aria-label="任务交付" aria-busy={busy}>
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
    {expectedResult && <div className="task-result-actions-buttons">
      {decision?.actions.includes('accept_result') && <button type="button" disabled={busy}
        onClick={() => void act('accept_task_result')}>接受并交付</button>}
      {decision?.actions.includes('retry_attempt') && <button type="button" disabled={busy}
        onClick={() => void act('retry_task_attempt')}>重新执行</button>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
