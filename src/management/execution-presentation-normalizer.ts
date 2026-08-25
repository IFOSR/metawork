import type { InteractionTraceEvent } from './interaction-trace.js';
import type { ConversationTurn, ConversationTurnProjection } from './web-session-types.js';

type TurnLike = ConversationTurn | ConversationTurnProjection;

export function normalizeExecutionPresentation<T extends TurnLike>(
  turn: T,
  aliases: ReadonlyMap<string, string>,
): T {
  if (aliases.size === 0) return structuredClone(turn);
  const canonical = (subtaskId: string): string => aliases.get(subtaskId) ?? subtaskId;
  return {
    ...structuredClone(turn),
    traceEvents: turn.traceEvents.map(event => normalizeTraceEvent(event, canonical)),
    executionTimeline: turn.executionTimeline
      ? {
          ...structuredClone(turn.executionTimeline),
          stages: turn.executionTimeline.stages.map(stage => ({
            ...stage,
            ...(stage.proposal ? {
              proposal: {
                ...stage.proposal,
                dependencies: stage.proposal.dependencies.map(([from, to]) => [
                  canonical(from),
                  canonical(to),
                ]),
              },
            } : {}),
            ...(stage.decisions ? {
              decisions: stage.decisions.map(decision => ({
                ...decision,
                subtask: canonical(decision.subtask),
              })),
            } : {}),
            ...(stage.subtasks ? {
              subtasks: stage.subtasks.map(subtask => ({
                ...subtask,
                id: canonical(subtask.id),
              })),
            } : {}),
          })),
        }
      : null,
  };
}

function normalizeTraceEvent(
  event: InteractionTraceEvent,
  canonical: (subtaskId: string) => string,
): InteractionTraceEvent {
  const detailsSubtaskId = typeof event.details.subtaskId === 'string'
    ? event.details.subtaskId
    : null;
  const subtaskId = event.subtaskId ?? detailsSubtaskId;
  if (!subtaskId) return structuredClone(event);
  const canonicalSubtaskId = canonical(subtaskId);
  return {
    ...structuredClone(event),
    subtaskId: canonicalSubtaskId,
    details: {
      ...structuredClone(event.details),
      subtaskId: canonicalSubtaskId,
    },
  };
}
