import { describe, expect, it } from 'vitest';
import { classifyResumeBlocker } from '../../src/execution/kernel-execution-runtime.js';

describe('classifyResumeBlocker', () => {
  it.each(['unknown_executor_failure', 'model_response_incomplete'])(
    'recognizes an incomplete response from an immutable %s receipt during explicit resume', code => {
      expect(classifyResumeBlocker('unknown requires explicit recovery', {
        kind: 'unknown', scope: 'attempt', code, summary: 'Stream ended without finish_reason',
      })).toBe('retry');
    },
  );

  it.each([
    ['startup recovery found running work without authorized dispatch', 'manual'],
    ['permission denied', 'explicit_resource'],
    ['contract validation failed', 'contract'],
    ['automatic recovery cannot prove external effect safety', 'manual'],
  ])('does not let a historical response failure override %s', (reason, category) => {
    expect(classifyResumeBlocker(reason, {
      kind: 'unknown', scope: 'attempt', code: 'unknown_executor_failure',
      summary: 'Stream ended without finish_reason',
    })).toBe(category);
  });

  it('classifies the startup-recovery orphan blocker as a manual blocker', () => {
    // The startup recovery orphan description contains the word "authorized",
    // but it is a manual (fail-closed) blocker, not an explicit-resource blocker.
    expect(classifyResumeBlocker(
      'startup recovery found running work without authorized dispatch',
    )).toBe('manual');
  });

  it('keeps explicit-resource classification for material/permission blockers', () => {
    expect(classifyResumeBlocker('explicit resource material is missing')).toBe('explicit_resource');
    expect(classifyResumeBlocker('等待用户授权后继续')).toBe('explicit_resource');
  });

  it('keeps the dependency-publication classification', () => {
    expect(classifyResumeBlocker('waiting for dependency publication')).toBe('dependency_publication');
  });

  it('keeps capacity and retry classification', () => {
    expect(classifyResumeBlocker('executor capacity exhausted')).toBe('capacity');
    expect(classifyResumeBlocker('network retry required')).toBe('retry');
  });

  it('repairs a legacy unknown blocker only when its latest receipt is clearly a network failure', () => {
    expect(classifyResumeBlocker(
      'unknown requires explicit recovery',
      { kind: 'unknown', scope: 'attempt', code: 'unknown_executor_failure', summary: 'Connection error.' },
    )).toBe('retry');
    expect(classifyResumeBlocker(
      'unknown requires explicit recovery',
      { kind: 'unknown', scope: 'attempt', code: 'unknown_executor_failure', summary: 'executor failed' },
    )).toBe('unknown');
  });
});
