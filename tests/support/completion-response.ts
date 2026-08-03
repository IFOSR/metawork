import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V2 } from '../../src/execution/completion-protocol.js';

export function completionResponse(
  _input: ExecutorInput,
  body = 'completed',
  artifacts: string[] = [],
): string {
  return `${body}\n\n${COMPLETION_MARKER_V2}\n${JSON.stringify({
    evidence: ['tests were not run: deterministic test fixture'],
    artifacts,
  })}`;
}
