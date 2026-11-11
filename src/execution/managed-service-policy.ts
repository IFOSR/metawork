/**
 * Task Runtime managed-service policy (ADR-0055 D5/D6).
 *
 * Formerly the inline `managed_service_requested` branch of
 * the retired policy decider. The Runtime owns the local service it started, so
 * it also owns who may start, stop, restart or observe it. A delivered artifact
 * stays a legitimate follow-up target: a finished Task never makes the Workspace
 * read-only.
 */
import { localServiceSpecificationRevision } from '../core/local-service-revision.js';
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import { decision } from '../control/control-contracts.js';

/**
 * Authorizes one explicit managed-service operation for the Task that owns it.
 */
export function decideManagedService(
  event: Extract<ControlEvent, { type: 'managed_service_requested' }>,
  snapshot: Extract<ControlSnapshot, { type: 'service_control' }>,
): ControlDecision {
  const facts = snapshot;
  const resourceTaskId = facts.retryOfTaskId ?? event.taskId;
  // A registration left by an earlier Task is a historical fact. When it
  // is the same Workspace and the same launch revision, the current Task
  // takes the service over instead of being refused for identity
  // (2026-10-27 realignment §4.2). A different Workspace or revision still
  // requires its own explicit authorization below.
  if (event.workspaceId && facts.serviceWorkspaceId && facts.serviceWorkspaceId !== event.workspaceId) {
    return decision(event, { type: 'reject_request' }, `服务不属于该 Workspace：serviceId=${event.serviceId}`);
  }
  const registrationFromOtherTask = Boolean(
    facts.serviceTaskId && facts.serviceTaskId !== resourceTaskId,
  );
  // The registration may be inherited only when both sides name the same
  // Workspace; the revision check below then decides whether it is the
  // same launch contract.
  const sameWorkspaceRegistration = Boolean(
    registrationFromOtherTask
    && event.workspaceId
    && facts.serviceWorkspaceId
    && facts.serviceWorkspaceId === event.workspaceId,
  );
  const inheritedRegistration = Boolean(
    sameWorkspaceRegistration
    && event.specificationRevision
    && facts.serviceRevision === event.specificationRevision,
  );
  if (!event.taskId || facts.task?.id !== event.taskId
    || (registrationFromOtherTask && !sameWorkspaceRegistration && !inheritedRegistration)
    || (event.specification && (event.specification.taskId !== resourceTaskId || event.specification.serviceId !== event.serviceId))) {
    return decision(event, { type: 'reject_request' },
      `服务归属不匹配：serviceId=${event.serviceId}，请求任务=${event.taskId ?? '未指定'}，`
      + `服务登记任务=${facts.serviceTaskId ?? '未登记'}，任务状态=${facts.task?.status ?? 'missing'}`);
  }
  if (event.specification && event.specificationRevision
    && localServiceSpecificationRevision(event.specification) !== event.specificationRevision) {
    return decision(event, { type: 'reject_request' }, `服务规格 revision 与请求内容不一致：serviceId=${event.serviceId}`);
  }
  if (event.operation !== 'update' && event.specificationRevision
    && facts.serviceRevision && facts.serviceRevision !== event.specificationRevision) {
    return decision(event, { type: 'reject_request' }, `服务规格 revision 与已授权 revision 不一致，需要显式更新授权：serviceId=${event.serviceId}`);
  }
  // A follow-up operation on an already delivered artifact is still a
  // legitimate user request. The historical Task status describes whether
  // that work finished; it does not make the Workspace read-only, so a
  // `succeeded` source Task must never refuse starting, restarting or
  // observing the service it produced (2026-10-28 transparent execution
  // §Kernel boundary). Coordination facts below still decide whether the
  // operation is mechanically applicable.
  if (event.operation !== 'stop' && !facts.published) {
    return decision(event, { type: 'reject_request' }, '代码尚未发布到用户任务目录，不能启动服务');
  }
  if (event.operation !== 'start' && !facts.serviceTaskId) return decision(event, { type: 'reject_request' }, '服务不存在');
  return decision(event, { type: 'control_managed_service', taskId: event.taskId, serviceId: event.serviceId,
    operation: event.operation, specification: event.specification,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    ...(event.specificationRevision ? { specificationRevision: event.specificationRevision } : {}),
  }, 'explicit managed service action authorized');
}
