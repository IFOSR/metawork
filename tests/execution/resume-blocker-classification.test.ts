import { describe, expect, it } from 'vitest';
import { classifyResumeBlocker } from '../../src/execution/kernel-execution-runtime.js';

describe('classifyResumeBlocker', () => {
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
});
