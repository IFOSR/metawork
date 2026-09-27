import type { GatewayEventEnvelope } from './client-events.js';
import {
  matchesTurnTaskObservation, observeTurnTaskTrace, type TurnTaskObservation,
} from './turn-task-observation.js';

export type TaskViewTurnAssociation =
  | {
      readonly status: 'matched';
      readonly startedAt: string | null;
      readonly completedAt: string | null;
      readonly progressSummary: string | null;
    }
  | { readonly status: 'mismatch' | 'not_found' };

export function resolveTaskViewTurnAssociation(input: {
  readonly accountId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly replayEvents?: readonly GatewayEventEnvelope[];
  readonly traceObservation?: TurnTaskObservation | null;
  readonly queryTaskId?: string | null;
  readonly liveTaskId?: string | null;
  readonly presentationTaskId?: string | null;
}): TaskViewTurnAssociation {
  let observation = input.traceObservation && matchesTurnTaskObservation(input, input.traceObservation)
    ? input.traceObservation : null;
  for (const event of input.replayEvents ?? []) observation = observeTurnTaskTrace(input, observation, event);
  const authoritativeTaskIds = new Set(observation?.taskIds ?? []);
  if (input.queryTaskId) authoritativeTaskIds.add(input.queryTaskId);
  if (input.liveTaskId) authoritativeTaskIds.add(input.liveTaskId);
  if (input.presentationTaskId) authoritativeTaskIds.add(input.presentationTaskId);

  if (authoritativeTaskIds.size > 1) return { status: 'mismatch' };
  if (authoritativeTaskIds.size === 0) return { status: 'not_found' };
  if (!authoritativeTaskIds.has(input.taskId)) return { status: 'mismatch' };

  return {
    status: 'matched',
    startedAt: observation?.firstTraceAt ?? null,
    completedAt: observation?.completedAt ?? null,
    progressSummary: observation?.progressSummary ?? null,
  };
}
