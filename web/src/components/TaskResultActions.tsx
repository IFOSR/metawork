import { useState } from 'react';
import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';
import type { WsClient } from '../api/ws';

export function TaskResultActions({ ws, conversationId, lifecycle, delivery, refresh }: {
  refresh(): void;
  ws: WsClient;
  conversationId: string;
  lifecycle?: GatewayTaskViewSnapshot['lifecycle'];
  delivery?: GatewayTaskViewSnapshot['publicDelivery'];
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
    {delivery && <div>
      <p>Workspace：{delivery.workspace}</p>
      <p>任务目录：{delivery.taskDirectory}</p>
      <p>代码状态：{{ not_published: '待发布', awaiting_acceptance: '等待用户接受', publishing: '正在发布到任务目录',
        published: '已发布到任务目录', failed: '发布失败' }[delivery.state]}</p>
      {delivery.files.length > 0 && <details><summary>交付文件（{delivery.files.length}）</summary>
        <ul>{delivery.files.map(file => <li key={file}>{file}</li>)}</ul></details>}
      {delivery.conflicts.length > 0 && <p role="alert">请处理冲突文件后继续：{delivery.conflicts.join('、')}</p>}
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
