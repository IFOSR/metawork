import { useEffect, useRef, useState } from 'react';
import type { ConversationActivityView, PendingInteractionSummary } from '../../../src/session/conversation-activity-types';
import type { HttpClient } from '../api/http';
import type { ConversationCommand, WsClient } from '../api/ws';

/** Each collection is a bounded page, independent of the transcript viewport. */
export function ObservedActivity({ conversationId, view, ws, http, showTasks = true }: {
  conversationId: string; view: ConversationActivityView; ws: WsClient; http: HttpClient;
  showTasks?: boolean;
}) {
  const [page, setPage] = useState<ConversationActivityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const cursors = useRef<{ task?: string; pending?: string }>({});
  // A changed live baseline invalidates stale paged controls. The user can page again.
  useEffect(() => { sequence.current++; cursors.current = {}; setPage(null); setLoading(false); }, [view, conversationId]);
  useEffect(() => () => { sequence.current++; }, []);
  const shown = page ?? view;
  const load = async (kind: 'task' | 'pending') => {
    const cursor = kind === 'task' ? shown.nextCursor : shown.pendingNextCursor;
    if (!cursor || loading) return;
    const ticket = ++sequence.current; const generation = ws.conversations.currentGeneration();
    const next = { ...cursors.current, [kind]: cursor };
    setLoading(true); setError(null);
    try {
      const value = await http.getConversationActivity(conversationId, next.task, next.pending);
      if (sequence.current === ticket && ws.conversations.currentGeneration() === generation) {
        cursors.current = next; setPage(value);
      }
    } catch (error) { if (sequence.current === ticket) setError((error as Error).message); }
    finally { if (sequence.current === ticket) setLoading(false); }
  };
  return <>
    {showTasks && shown.tasks.length > 0 && <section aria-label="活动任务">
      {shown.tasks.map(task => <div key={task.taskId}>
        <strong>{task.title}</strong> <span>{task.explanation}</span>
        {task.progressSummary && <p>{task.progressSummary}</p>}
        {task.canCancel && <TaskControl key={`${task.taskId}:${task.executionGeneration}`} ws={ws} conversationId={conversationId} command={{
          kind: 'cancel_task', taskId: task.taskId, expectedExecutionGeneration: task.executionGeneration,
        }} />}
      </div>)}
      {shown.nextCursor && <button disabled={loading} onClick={() => void load('task')}>下一页任务</button>}
    </section>}
    {shown.pendingInteractions.map(request => <PendingInteraction key={`${request.requestId}:${request.requestRevision}`}
      conversationId={conversationId} request={request} http={http} ws={ws} />)}
    {shown.pendingNextCursor && <button disabled={loading} onClick={() => void load('pending')}>下一页待审批</button>}
    {page && <button onClick={() => { sequence.current++; cursors.current = {}; setPage(null); setLoading(false); }}>返回第一页</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}

function PendingInteraction({ conversationId, request, http, ws }: {
  conversationId: string; request: PendingInteractionSummary; http: HttpClient; ws: WsClient;
}) {
  const [details, setDetails] = useState<{ text: string; nextOffset: number } | null>(null);
  const [reviewed, setReviewed] = useState(!request.detailsRef);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const control = useControl(ws, conversationId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const read = async (offset: number) => {
    if (!request.detailsRef || loading) return;
    const generation = ws.conversations.currentGeneration();
    setLoading(true); setError(null);
    try {
      const part = await http.getConversationContent(conversationId, request.detailsRef.hash, offset);
      if (alive.current && ws.conversations.currentGeneration() === generation) {
        setDetails(part); if (part.nextOffset >= part.byteLength) setReviewed(true);
      }
    } catch (error) { if (alive.current) setError((error as Error).message); }
    finally { if (alive.current) setLoading(false); }
  };
  return <section aria-label="等待授权">
    <strong>等待授权：{request.operation}</strong><p>{request.resource}</p><p>{request.reason}</p>
    <span>范围：{request.scope}</span>
    {request.detailsRef && <div>
      <button disabled={loading} onClick={() => void read(0)}>查看完整申请</button>
      {details && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details.text}</pre>}
      {details && details.nextOffset < request.detailsRef.byteLength && <button disabled={loading}
        onClick={() => void read(details.nextOffset)}>继续阅读申请</button>}
      {!reviewed && <p>请先查看完整申请，再决定是否同意。</p>}
    </div>}
    {(['approve', 'deny'] as const).map(resolution => <button key={resolution} disabled={control.busy || (resolution === 'approve' && !reviewed)}
      onClick={() => void control.submit({
        kind: 'permission_resolution_v2', requestId: request.requestId, requestRevision: request.requestRevision,
        expectedExecutionGeneration: request.generationId, resolution,
      })}>{resolution === 'approve' ? '同意' : '拒绝'}</button>)}
    {control.message && <p role="status">{control.message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function useControl(ws: WsClient, conversationId: string) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async (command: Extract<ConversationCommand, { kind: 'cancel_task' | 'permission_resolution_v2' }>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('正在提交…');
    try {
      const result = await ws.control(conversationId, command, () => {
        if (alive.current) setMessage('请求已受理，正在等待处理。');
      });
      if (!alive.current) return;
      if (result.status === 'completed') setMessage(command.kind === 'cancel_task'
        ? '停止请求已处理，正在等待执行清理。' : '授权操作已处理，正在更新任务状态。');
      else { setMessage(`操作未完成：${result.reason ?? '请查询最新状态'}`); setBusy(false); inFlight.current = false; }
    } catch (error) {
      if (!alive.current) return;
      setMessage((error as Error).message === 'command_status_unknown' ? '处理状态待确认，请查询任务最新状态。' : `操作未完成：${(error as Error).message}`);
      setBusy(false); inFlight.current = false;
    }
  };
  return { busy, message, submit };
}

function TaskControl({ ws, conversationId, command }: {
  ws: WsClient; conversationId: string; command: Extract<ConversationCommand, { kind: 'cancel_task' }>;
}) {
  const control = useControl(ws, conversationId);
  return <><button disabled={control.busy} onClick={() => void control.submit(command)}>停止任务</button>
    {control.message && <p role="status">{control.message}</p>}</>;
}
