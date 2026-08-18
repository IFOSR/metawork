/**
 * 账户生命周期纯辅助（ADR-0031 第 11 节）。
 *
 * 账户关闭前必须满足：零已连接客户端、无活动 Task/runtime 工作、且完成持久
 * 空闲检查点。busy 账户不能关闭。
 */

export interface AccountLifecycleState {
  readonly attachedClients: number;
  readonly activeWork: boolean;
}

export function isAccountIdle(state: AccountLifecycleState): boolean {
  return state.attachedClients === 0 && !state.activeWork;
}

export function isAccountBusy(state: AccountLifecycleState): boolean {
  return !isAccountIdle(state);
}
