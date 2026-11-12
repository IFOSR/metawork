import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';

export function isUnknownTaskBlocker(reason?: string): boolean {
  if (!reason) return false;
  return /unknown_executor_failure|unknown requires explicit recovery|\bunknown\b|结果不确定|无法确认.*副作用|automatic recovery cannot prove external effect safety|explicit recovery/i.test(reason);
}

export function formatBlockedTaskReason(reason: string): string {
  if (/upstream_stream_interrupted|response stream (?:was )?interrupted/i.test(reason)) {
    const upstreamDetail = /(?:upstream\s+)?response\s+stream\s+(?:was\s+)?interrupted/i.exec(reason)?.[0];
    return [
      'Executor 已启动，但上游模型响应流中断，未收到可用结果',
      '系统无法确认上次请求是否产生外部影响，需要人工确认后恢复',
      upstreamDetail ? `上游返回：${upstreamDetail}` : undefined,
    ].filter(Boolean).join('；');
  }
  if (isUnknownTaskBlocker(reason)) {
    return `上次执行结果不确定，需要先确认恢复安全性（${reason}）`;
  }
  return reason;
}

export function formatBlockedTaskNextStep(taskId: string, reason: string): string {
  if (isUnknownTaskBlocker(reason)) {
    return `材料齐全不等于可以安全恢复；请先执行 /task recovery ${taskId} 查看恢复项。若没有恢复项，需要人工确认上次执行是否产生外部副作用后再重新提交`;
  }

  if (/材料|文件|链接|文档|资料|补充|缺少|等待/i.test(reason)) {
    return `补充材料/文件/链接后，再执行 /task resume ${taskId}`;
  }

  if (isPermissionFailure(reason) || /授权|权限/i.test(reason)) {
    return `确认权限/授权后，再执行 /task resume ${taskId}`;
  }

  if (isRecoverableExecutorFailure(reason)) {
    return '等待执行器或网络恢复；系统会按恢复策略重试';
  }

  return `确认处理条件已满足后执行 /task resume ${taskId}`;
}

export function formatBlockedTaskRecoveryAction(taskId: string, reason: string): string {
  if (isUnknownTaskBlocker(reason)) {
    return `材料齐全不等于可以安全恢复；先执行 /task recovery ${taskId} 查看恢复项；没有恢复项时，不能安全地直接重试`;
  }
  return `/task resume ${taskId}`;
}

export function formatEmptyTaskRecovery(
  taskId: string,
  input: { status?: string; blockerReason?: string; canResume?: boolean },
): string | null {
  if (input.status !== 'needs_action') return null;
  const reason = input.blockerReason?.trim();
  // Blocked Tasks without queue items are a dead end for the user unless the
  // answer says what to do next. Previously only a narrow "unknown blocker"
  // phrase produced guidance; everything else fell back to an English line.
  const unknown = isUnknownTaskBlocker(reason);
  return [
    `任务 #${taskId} 没有自动恢复项`,
    reason ? `待处理原因：${formatBlockedTaskReason(reason)}` : '待处理原因：任务被阻塞，但没有可重放的执行或副作用记录',
    unknown
      ? '系统无法核实上次执行的外部结果，不能通过重复点击继续来消除该阻塞。请先核对实际文件、服务或外部操作结果。'
      : '这次阻塞没有可重放的恢复记录。',
    !unknown && input.canResume
      ? `下一步：处理上述原因后执行 /task resume ${taskId}，系统会重新检查剩余工作的恢复条件。`
      : `下一步：核对实际结果后执行 /task cancel ${taskId} 结束旧任务并保留已有产物，再说明尚未完成的工作和核对结果，让系统重新规划。`,
  ].join('\n');
}
