import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Control contract architecture', () => {
  it('does not import Session, Task Runtime, Execution, or Storage modules', () => {
    const source = readFileSync('src/control/control-contracts.ts', 'utf8');
    // The control contracts may depend on these pure Task value contracts, never Task Runtime.
    // `task-state.ts` is the six-state value contract: it has no imports at all,
    // and the control loop is its documented policy caller.
    const withoutValueImports = source
      .replace(/import type \{[^}]+\} from '\.\.\/task\/(?:local-service|safe-result-identity)\.js';/gu, '')
      .replace(/import \{ isTerminalTaskStatus \} from '\.\.\/task\/task-state\.js';\n/gu, '')
      .replace(/import type \{ TaskStatus \} from '\.\.\/task\/task-state\.js';\n/gu, '');
    expect(withoutValueImports).not.toMatch(/\.\.\/(session|task|execution|storage)\//);
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('generateInteractionId');
  });

  it('keeps the execution control loop out of the transport contracts', () => {
    const source = readFileSync('src/control/control-contracts.ts', 'utf8');
    // ADR-0055 D3+D4+D5: dispatch, capacity, failure/retry, resume, partition,
    // sandbox and merge-repair policy moved into `src/execution/*-policy.ts`.
    // A reintroduced producer here would be a second control loop.
    // The module is now transport only: contracts, decision factory and guards.
    expect(source).not.toContain('export class ControlLoopPolicy');
    for (const retired of [
      'decideDispatch',
      'decideCapacity',
      'decideOutcome',
      'decideFailure',
      'decideTimer',
      'decideTaskResume',
      'decideMergeConflict',
      'decideSandboxRecovery',
      'decidePartitionConflict',
      'decideGenerationQuiescence',
      'selectDispatchableSubtasks',
      'dispatchBatchItems',
      'singleDispatchBatch',
    ]) {
      expect(source).not.toContain(retired);
    }
  });

  it('keeps PlanningAgent implementation types out of Runtime', () => {
    const runtimeSources = [
      'src/execution/execution-runtime.ts',
      'src/execution/subtask-attempt-runner.ts',
      'src/execution/control-execution-runtime.ts',
      'src/session/session-control-runtime.ts',
    ].map(path => readFileSync(path, 'utf8')).join('\n');
    expect(runtimeSources).not.toMatch(/PlanningAgentPlan|planning-types|planning-agent/);
  });
});
