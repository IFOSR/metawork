import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V1 } from '../../src/execution/completion-protocol.js';

export function completionResponse(
  input: ExecutorInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  return `${body}\n\n${COMPLETION_MARKER_V1}\n${JSON.stringify({
    schemaVersion: 1,
    subtaskId: input.context.currentSubtask.id,
    acceptanceEvidence: input.context.currentSubtask.acceptance.map(criterion => ({
      key: criterion.key,
      evidence: ['tests were not run: deterministic test fixture'],
    })),
    artifacts,
    handoffs: input.context.outgoingHandoffRequirements.map(contract => ({
      toSubtaskId: contract.toSubtaskId,
      items: contract.requiredItems.map(item => item.type === 'text'
        ? { key: item.key, type: 'text', value: `${body} (${item.description})` }
        : { key: item.key, type: 'artifact', paths: artifacts }),
    })),
  })}`;
}
