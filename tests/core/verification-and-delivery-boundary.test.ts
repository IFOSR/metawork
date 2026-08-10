import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 2 verification boundary', () => {
  it('verifies each completion before clean output reaches Session delivery', () => {
    const runner = readFileSync('src/execution/subtask-attempt-runner.ts', 'utf8');
    const session = readFileSync('src/execution/kernel-execution-runtime.ts', 'utf8');
    expect(runner).toContain('validateCompletionProtocol');
    expect(session).toContain('outcome.output');
    expect(session).not.toContain('prepareAsync');
  });
});
