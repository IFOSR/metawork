import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ControlKernel architecture', () => {
  it('does not import Session, Task Runtime, Execution, or Storage modules', () => {
    const source = readFileSync('src/kernel/control-kernel.ts', 'utf8');
    // Kernel may depend on these pure Task value contracts, never Task Runtime.
    const withoutValueImports = source.replace(/import type \{[^}]+\} from '\.\.\/task\/(?:local-service|safe-result-identity)\.js';/gu, '');
    expect(withoutValueImports).not.toMatch(/\.\.\/(session|task|execution|storage)\//);
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('generateInteractionId');
  });

  it('keeps PlanningAgent implementation types out of Runtime', () => {
    const runtimeSources = [
      'src/execution/execution-runtime.ts',
      'src/execution/subtask-attempt-runner.ts',
      'src/execution/kernel-execution-runtime.ts',
      'src/session/session-kernel-runtime.ts',
    ].map(path => readFileSync(path, 'utf8')).join('\n');
    expect(runtimeSources).not.toMatch(/PlanningAgentPlan|planning-types|planning-agent/);
  });
});
