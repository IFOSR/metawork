import { useState } from 'react';
import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';

type Permission = GatewayTaskViewSnapshot['pendingPermission'];

/**
 * Inline "this needs you" card. Every blocked Turn renders its own entry point so
 * the user never has to scroll to a list at the top of the conversation to find
 * out what to click.
 *
 * Priority: an authorization request first (it is the actual blocker), then the
 * result decision, then a recovery entry point.
 */
export function BlockedActions({ ws, http, conversationId, taskId, lifecycle, permission }: {
  ws: WsClient;
  http: HttpClient;
  conversationId: string;
  taskId: string | null;
  lifecycle?: GatewayTaskViewSnapshot['lifecycle'];
  permission?: Permission;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState<{ text: string; truncated: boolean } | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);

  const reason = lifecycle?.userStateReason?.trim() ?? '';
  const needsAction = lifecycle?.userState === 'needs_action';
  const pendingDecision = lifecycle?.pendingDecision ?? null;
  const hasPermission = permission?.status === 'pending' && Boolean(permission.requestId);

  const resolvePermission = async (resolution: 'approve' | 'deny'): Promise<void> => {
    if (!permission?.requestRevision || !permission.generationId) {
      setMessage('授权请求缺少版本信息，请刷新后再试。');
      return;
    }
    setBusy(true);
    setMessage(resolution === 'approve' ? '正在提交授权…' : '正在提交拒绝…');
    try {
      const result = await ws.control(conversationId, {
        kind: 'permission_resolution_v2',
        requestId: permission.requestId,
        requestRevision: permission.requestRevision,
        expectedExecutionGeneration: permission.generationId,
        resolution,
      }, () => undefined);
      setMessage(result.status === 'rejected'
        ? result.reason ?? '授权请求已过期，请刷新后重试。'
        : resolution === 'approve' ? '已授权，任务将继续执行。' : '已拒绝，任务将停止该操作。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '授权提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const runCommand = (text: string): void => {
    const requestId = ws.sendCommand(conversationId, { kind: 'slash_command', text });
    setMessage(requestId === null
      ? '连接不可用，请稍后重试。'
      : `已提交 ${text}，结果会出现在下方新增的一轮回复里。`);
  };

  const reviewRequest = async (): Promise<void> => {
    setBusy(true);
    setMessage('正在读取完整申请…');
    try {
      const activity = await http.getConversationActivity(conversationId);
      const request = activity.pendingInteractions.find(item => item.requestId === permission?.requestId);
      if (!request?.detailsRef) {
        setDetails(null);
        setMessage('该申请没有可展开的完整内容，可直接同意或拒绝。');
        return;
      }
      const part = await http.getConversationContent(conversationId, request.detailsRef.hash, 0);
      setDetails({ text: part.text, truncated: part.nextOffset < part.byteLength });
      setReviewRequired(false);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取申请内容失败。');
    } finally {
      setBusy(false);
    }
  };

  const cancelTask = async (): Promise<void> => {
    if (!taskId || !lifecycle?.executionGeneration) {
      setMessage('缺少执行批次信息，请刷新后再试。');
      return;
    }
    setBusy(true);
    setMessage('正在取消任务…');
    try {
      const result = await ws.control(conversationId, {
        kind: 'cancel_task', taskId, expectedExecutionGeneration: lifecycle.executionGeneration,
      }, () => undefined);
      setMessage(result.status === 'rejected' ? result.reason ?? '取消失败，请刷新后重试。' : '已请求取消任务。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '取消任务失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  if (!hasPermission && !pendingDecision && !needsAction) return null;

  return (
    <section className="blocked-actions" data-kind={hasPermission ? 'permission' : pendingDecision ? 'decision' : 'recovery'}>
      {hasPermission && (
        <>
          <p className="blocked-actions-title">
            等待你的授权{permission.summary ? `：${permission.summary}` : ''}
          </p>
          <p className="blocked-actions-hint">授权后任务会从暂停处继续，不需要重新执行已完成的部分。</p>
          <div className="blocked-actions-buttons">
            <button type="button" className="primary" disabled={busy || reviewRequired}
              onClick={() => void resolvePermission('approve')}>同意并继续</button>
            <button type="button" disabled={busy} onClick={() => void resolvePermission('deny')}>拒绝</button>
            <button type="button" disabled={busy} onClick={() => void reviewRequest()}>查看完整申请</button>
          </div>
          {details && (
            <div className="blocked-actions-details">
              <pre>{details.text}</pre>
              {details.truncated && <p>内容较长，已截断显示。</p>}
            </div>
          )}
        </>
      )}
      {!hasPermission && needsAction && (
        <>
          <p className="blocked-actions-title">需要你的处理才能继续</p>
          {reason && <p className="blocked-actions-hint">{reason}</p>}
          <div className="blocked-actions-buttons">
            {taskId && (
              <button type="button" className="primary" disabled={busy}
                onClick={() => runCommand(`/task resume ${taskId}`)}>继续未完成部分</button>
            )}
            {taskId && (
              <button type="button" disabled={busy}
                onClick={() => runCommand(`/task recovery ${taskId}`)}>查看恢复项</button>
            )}
            {taskId && lifecycle?.executionGeneration && (
              <button type="button" disabled={busy} onClick={() => void cancelTask()}>取消任务</button>
            )}
          </div>
        </>
      )}
      {message && <p className="blocked-actions-message" role="status">{message}</p>}
    </section>
  );
}
