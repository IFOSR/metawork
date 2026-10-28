/**
 * Internal node state used for the graph's visual encoding (`data-status`).
 * It is never rendered as a status label: the six-state Task conclusion is the
 * only status a user sees.
 */
export type WorkGraphExecutionState = 'completed' | 'running' | 'waiting' | 'blocked' | 'failed' | 'unknown';

export function workGraphExecutionState(status: string): WorkGraphExecutionState {
  if (status === 'done' || status === 'completed' || status === 'succeeded') return 'completed';
  if (['running', 'launching'].includes(status)) return 'running';
  if (['ready', 'awaiting_integration', 'pending', 'pending_launch'].includes(status)) return 'waiting';
  if (['blocked', 'awaiting_decision', 'uncertain'].includes(status)) return 'blocked';
  if (['failed', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'unknown';
}
