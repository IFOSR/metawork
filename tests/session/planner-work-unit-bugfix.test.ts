import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 2 planner/work-unit regressions', () => {
  it('does not reset stale or blocked Subtasks to ready during graph recovery', () => {
    const source = readFileSync('src/execution/work-graph-runtime-service.ts', 'utf8');
    expect(source).toContain("status: 'blocked'");
    expect(source).not.toContain('subtask_recovered_for_dispatch');
  });

  it('releases the exact claim in Attempt Runner finally', () => {
    const source = readFileSync('src/execution/subtask-attempt-runner.ts', 'utf8');
    expect(source).toContain('finally');
    expect(source).toContain('claim.release()');
    expect(source).toContain('evidenceCapability?.revoke()');
  });

  it('does not implement retry, fallback, or backoff policy in the Runner', () => {
    const source = readFileSync('src/execution/subtask-attempt-runner.ts', 'utf8');
    expect(source).not.toContain('retryCount');
    expect(source).not.toContain('fallbackExecutor');
    expect(source).not.toContain('backoff');
  });
});
