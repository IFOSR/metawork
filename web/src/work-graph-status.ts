export type WorkGraphExecutionState = 'completed' | 'running' | 'waiting' | 'blocked' | 'failed' | 'unknown';

export const WORK_GRAPH_STATUS_LABEL: Record<WorkGraphExecutionState, string> = {
  completed: '已完成',
  running: '执行中',
  waiting: '待执行',
  blocked: '已阻塞',
  failed: '失败',
  unknown: '状态待确认',
};

export function workGraphExecutionState(status: string): WorkGraphExecutionState {
  if (status === 'done' || status === 'completed' || status === 'succeeded') return 'completed';
  if (['running', 'launching'].includes(status)) return 'running';
  if (['ready', 'awaiting_integration', 'pending', 'pending_launch'].includes(status)) return 'waiting';
  if (['blocked', 'awaiting_decision', 'uncertain'].includes(status)) return 'blocked';
  if (['failed', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'unknown';
}
