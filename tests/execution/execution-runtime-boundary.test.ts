import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 2 execution boundaries', () => {
  const session = readFileSync('src/session/session-execution-coordinator.ts', 'utf8');
  const runner = readFileSync('src/execution/subtask-attempt-runner.ts', 'utf8');

  it('keeps Session as a serial ready-node shell', () => {
    expect(session).toContain('attemptRunner.run');
    expect(session).not.toContain('executorInput:');
    expect(session).not.toContain('conversationHistory');
    expect(session).not.toContain('executionContextBundle');
  });

  it('centralizes claim, context, completion and release in the Attempt Runner', () => {
    expect(runner).toContain('workUnitClaimService.claim');
    expect(runner).toContain('contextBuilder.build');
    expect(runner).toContain('validateCompletionProtocol');
    expect(runner).toContain('claim.release()');
  });
});
