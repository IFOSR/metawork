import { isPermissionFailure, isRecoverableExecutorFailure } from '../executor/error-utils.js';

export function isUnknownTaskBlocker(reason?: string): boolean {
  if (!reason) return false;
  return /unknown_executor_failure|unknown requires explicit recovery|\bunknown\b|结果不确定|无法确认.*副作用|explicit recovery/i.test(reason);
}

export function formatBlockedTaskReason(reason: string): string {
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
    return `补充材料/文件/链接后，再执行 /task unblock ${taskId}`;
  }

  if (isPermissionFailure(reason) || /授权|权限/i.test(reason)) {
    return `确认权限/授权后，再执行 /task unblock ${taskId}`;
  }

  if (isRecoverableExecutorFailure(reason)) {
    return '等待执行器或网络恢复；系统会按恢复策略重试';
  }

  return `确认阻塞条件已解除后执行 /task unblock ${taskId}`;
}

export function formatBlockedTaskRecoveryAction(taskId: string, reason: string): string {
  if (isUnknownTaskBlocker(reason)) {
    return `材料齐全不等于可以安全恢复；先执行 /task recovery ${taskId} 查看恢复项；没有恢复项时，不能安全地直接重试`;
  }
  return `/task unblock ${taskId}`;
}

export function formatEmptyTaskRecovery(
  taskId: string,
  input: { status?: string; blockerReason?: string },
): string | null {
  if (input.status !== 'blocked' || !isUnknownTaskBlocker(input.blockerReason)) {
    return null;
  }

  const reason = input.blockerReason!;
  return [
    `任务 #${taskId} 当前仍为 BLOCKED`,
    `阻塞原因：${formatBlockedTaskReason(reason)}`,
    '没有可供 /task recover 使用的恢复项。',
    '这不表示阻塞已解除，也不表示上次 Executor 没有产生副作用；系统因此不会自动重试。',
    `下一步：人工核对外部系统和工作区；确认没有副作用后可执行 /task cancel ${taskId}，再重新提交需求；如果已产生结果，请基于结果创建 follow-up 任务。`,
  ].join('\n');
}
