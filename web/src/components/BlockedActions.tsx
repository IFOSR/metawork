import { useState } from 'react';
import type { GatewayTaskViewSnapshot } from '../../../src/gateway/task-view';
import type { TaskPendingAction, TaskPendingResultIdentity } from '../../../src/task/task-state';
import type { HttpClient } from '../api/http';
import type { WsClient } from '../api/ws';
import { isOfficialAuthorizationBlock, userFacingBlockReason } from '../block-reason';

type Permission = GatewayTaskViewSnapshot['pendingPermission'];

/**
 * Inline "this needs you" card. Every blocked Turn renders its own entry point so
 * the user never has to scroll to a list at the top of the conversation to find
 * out what to click.
 *
 * Priority: an authorization request first (it is the actual blocker), then the
 * result decision, then a recovery entry point.
 */
export function BlockedActions({ ws, http, conversationId, taskId, fallbackStatus, lifecycle, permission, refresh }: {
  ws: WsClient;
  http: HttpClient;
  conversationId: string;
  taskId: string | null;
  /** Turn status lets the inline control remain usable while the read-only
   * TaskView query is still loading or temporarily unavailable. */
  fallbackStatus?: 'blocked' | 'failed' | null;
  lifecycle?: GatewayTaskViewSnapshot['lifecycle'];
  permission?: Permission;
  refresh?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState<{ text: string; truncated: boolean } | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);

  // Keep the card tolerant of an older read-model projection while the Server
  // and Web bundle are rolled forward independently. New projections always
  // provide status/reason/pendingActions; the fallback only maps the old
  // pendingDecision shape into the same action model.
  const legacy = lifecycle as (GatewayTaskViewSnapshot['lifecycle'] & {
    userState?: string;
    userStateReason?: string;
    pendingDecision?: {
      expectedResult?: TaskPendingResultIdentity | null;
      actions?: readonly string[];
    } | null;
  } | undefined);
  const rawReason = lifecycle?.reason?.message?.trim() ?? legacy?.userStateReason?.trim() ?? '';
  const reason = userFacingBlockReason(rawReason);
  const authorizationBlocked = isOfficialAuthorizationBlock(rawReason);
  const needsAction = lifecycle?.status === 'needs_action'
    || legacy?.userState === 'needs_action'
    || (!lifecycle && fallbackStatus === 'blocked');
  const failed = lifecycle?.status === 'failed' || (!lifecycle && fallbackStatus === 'failed');
  const pendingActions = lifecycle?.pendingActions ?? (legacy?.pendingDecision?.actions ?? []).map(action => ({
    actionId: `legacy:${action}`,
    kind: action === 'retry_attempt' ? 'retry_attempt' : 'accept_result',
    label: action === 'retry_attempt' ? '重新执行' : '接受并交付',
    reason: { code: 'input_required', message: reason, evidenceRefs: [] },
    result: legacy?.pendingDecision?.expectedResult ?? null,
  } as TaskPendingAction));
  const candidateAction = pendingActions.find(action => action.kind === 'accept_result'
    && (Boolean(action.publicationId) || action.actionId.startsWith('accept_partial:'))) ?? null;
  const acceptAction = pendingActions.find(action => action.kind === 'accept_result' && !action.publicationId) ?? null;
  const retryAction = pendingActions.find(action => action.kind === 'retry_attempt') ?? null;
  const recoveryAction = pendingActions.find(action => action.kind === 'resolve_recovery') ?? null;
  const pendingDecision = acceptAction || retryAction
    ? {
        expectedResult: acceptAction?.result ?? retryAction?.result ?? undefined,
        actions: [
          ...(acceptAction ? ['accept_result' as const] : []),
          ...(retryAction ? ['retry_attempt' as const] : []),
        ],
      }
    : null;
  const hasPermission = permission?.status === 'pending' && Boolean(permission.requestId);
  const canAcceptResult = Boolean(pendingDecision?.expectedResult)
    && Boolean(pendingDecision?.actions.includes('accept_result'));
  const canRetryAttempt = Boolean(pendingDecision?.expectedResult)
    && Boolean(pendingDecision?.actions.includes('retry_attempt'));
  // A pending result decision *is* the blocker: resume/recovery would only add
  // noise next to accept/retry.
  const canAcceptCandidate = Boolean(taskId) && Boolean(candidateAction);
  const canResume = Boolean(taskId) && !pendingDecision && !canAcceptCandidate && needsAction;
  const canRetryRemaining = Boolean(taskId) && !pendingDecision && failed;
  const canResolveRecovery = Boolean(taskId) && (Boolean(recoveryAction) || Boolean(legacy?.recoveryDiagnosis));
  const primaryAction = primaryActionFor(lifecycle?.nextAuthorizedAction, {
    canAcceptCandidate,
    canAcceptResult,
    canRetryAttempt,
    canResume,
    canRetryRemaining,
    canResolveRecovery,
  });
  const recommendation = recommendationFor(primaryAction);

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

  const resolveResult = async (kind: 'accept_task_result' | 'retry_task_attempt'): Promise<void> => {
    const expectedResult = pendingDecision?.expectedResult;
    if (!expectedResult || busy) return;
    setBusy(true);
    setMessage(kind === 'accept_task_result' ? '正在接受结果…' : '正在提交重新执行…');
    try {
      const result = await ws.control(conversationId, { kind, expectedResult }, () => undefined);
      setMessage(result.status === 'rejected'
        ? result.reason ?? '结果操作已过期，请等待任务刷新后重试。'
        : kind === 'accept_task_result' ? '已接受，任务正在进入交付。' : '已提交重新执行，任务状态正在刷新。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败，请刷新任务后重试。');
    } finally {
      refresh?.();
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

  if (!hasPermission && !pendingDecision && !needsAction && !canRetryRemaining) return null;

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
      {!hasPermission && (pendingDecision || needsAction || canRetryRemaining) && (
        <>
          <p className="blocked-actions-title">{failed ? '任务失败，需要处理' : '需要你的处理才能继续'}</p>
          {reason && <p className="blocked-actions-hint">{reason}</p>}
          {failed && (
            <p className="blocked-actions-hint">
              直接在下方说明要继续或修复什么，系统会用上面的真实错误开启新的一轮；旧任务记录会保留，无需先清理。
            </p>
          )}
          {(authorizationBlocked || recommendation) && (
            <p className="blocked-actions-recommendation">{authorizationBlocked
              ? '下一步：先点页面右上角「登录 / 注册」完成官方账号登录，再点「继续未完成部分」。'
              : recommendation}</p>
          )}
          <div className="blocked-actions-buttons">
            {/* The Kernel already decided which action is authorized next; the
                card renders exactly those actions and highlights that one. */}
            {canAcceptResult && (
              <button type="button" className={primaryAction === 'accept_result' ? 'primary' : undefined}
                disabled={busy} onClick={() => void resolveResult('accept_task_result')}>接受并交付</button>
            )}
            {canAcceptCandidate && (
              <button type="button" className={primaryAction === 'accept_candidate' ? 'primary' : undefined}
                disabled={busy} onClick={() => runCommand(`/task accept-partial ${taskId}`)}>
                {candidateAction?.publicationId ? '接受候选并发布' : '接受部分结果并继续'}
              </button>
            )}
            {canRetryAttempt && (
              <button type="button" className={primaryAction === 'retry_attempt' ? 'primary' : undefined}
                disabled={busy} onClick={() => void resolveResult('retry_task_attempt')}>重新执行</button>
            )}
            {canResume && (
              <button type="button" className={primaryAction === 'resume' ? 'primary' : undefined}
                disabled={busy}
                onClick={() => runCommand(`/task resume ${taskId}`)}>继续未完成部分</button>
            )}
            {canRetryRemaining && (
              <button type="button"
                className={primaryAction === 'retry_remaining' && !failed ? 'primary' : undefined}
                disabled={busy}
                onClick={() => runCommand(`/task retry ${taskId}`)}>
                重试未完成部分
              </button>
            )}
            {canResolveRecovery && (
              <button type="button" className={primaryAction === 'resolve_recovery' ? 'primary' : undefined}
                disabled={busy}
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

type BlockedPrimaryAction = 'accept_result' | 'accept_candidate' | 'retry_attempt' | 'resume' | 'retry_remaining' | 'resolve_recovery' | null;

/**
 * Picks the one highlighted action from the Kernel's own `nextAuthorizedAction`,
 * so the copy and the buttons can never disagree about what to click.
 */
function primaryActionFor(
  nextAuthorizedAction: string | undefined,
  available: {
    canAcceptCandidate: boolean;
    canAcceptResult: boolean;
    canRetryAttempt: boolean;
    canResume: boolean;
    canRetryRemaining?: boolean;
    canResolveRecovery: boolean;
  },
): BlockedPrimaryAction {
  const candidate: BlockedPrimaryAction = nextAuthorizedAction === 'accept_result'
    ? available.canAcceptResult
      ? 'accept_result'
      : available.canAcceptCandidate
        ? 'accept_candidate'
        : null
    : nextAuthorizedAction === 'retry_attempt' && available.canRetryAttempt
      ? 'retry_attempt'
      : (nextAuthorizedAction === 'explicit_resume_required' || nextAuthorizedAction === 'await_user_input') && available.canResume
        ? 'resume'
        : nextAuthorizedAction === 'resolve_uncertain_application' && available.canResolveRecovery
          ? 'resolve_recovery'
          : nextAuthorizedAction === 'none' && available.canRetryRemaining
            ? 'retry_remaining'
          : null;
  if (candidate) return candidate;
  // Fall back to the only available action when the Kernel named none of them.
  if (available.canAcceptResult) return 'accept_result';
  if (available.canAcceptCandidate) return 'accept_candidate';
  if (available.canResume) return 'resume';
  if (available.canRetryRemaining) return 'retry_remaining';
  if (available.canResolveRecovery) return 'resolve_recovery';
  if (available.canRetryAttempt) return 'retry_attempt';
  return null;
}

/** One sentence that names the button and says when the alternative applies. */
function recommendationFor(action: BlockedPrimaryAction): string {
  switch (action) {
    case 'accept_result':
      return '下一步：点「接受并交付」。结果已通过安全校验，接受后直接进入交付；只有你认为结果不正确时才选「重新执行」。';
    case 'accept_candidate':
      return '下一步：点「接受候选并发布」，候选变更才会写入目标 Workspace。';
    case 'retry_attempt':
      return '下一步：点「重新执行」，让系统用当前任务图再跑一次这一步。';
    case 'resume':
      return '下一步：点「继续未完成部分」，已完成的部分不会重跑。';
    case 'resolve_recovery':
      return '下一步：点「查看恢复项」，先确认上次执行是否留下了外部影响。';
    case 'retry_remaining':
      return '下一步：点「重试未完成部分」。已完成的代码不会重新执行，只补做失败的交付或服务启动。';
    default:
      return '';
  }
}
