import { gatewayEventPayloadBytes, MAX_GATEWAY_EVENT_PAYLOAD_BYTES } from './client-events.js';
import type { GatewayTaskViewSnapshot } from './task-view.js';

/** Keep current state deliverable; verbose progress remains in paged trace/detail reads. */
export function boundTaskViewPayload(view: GatewayTaskViewSnapshot): GatewayTaskViewSnapshot {
  if (gatewayEventPayloadBytes(view) <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES || !view.timeline) return view;
  return {
    ...view,
    timeline: {
      ...view.timeline,
      stages: view.timeline.stages.map(stage => ({
        ...stage,
        ...(stage.subtasks ? {
          subtasks: stage.subtasks.map(subtask => ({
            ...subtask,
            attempts: subtask.attempts.map(attempt => {
              const { progress: _progress, progressHistory, ...identityAndState } = attempt;
              return {
                ...identityAndState,
                ...(progressHistory?.length ? {
                  progressHistory: progressHistory.slice(-1).map(entry => ({ ...entry, text: entry.text.slice(0, 500) })),
                } : {}),
              };
            }),
          })),
        } : {}),
      })),
    },
  };
}
