import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ControlEvent, type ControlSnapshot } from '../../src/control/control-contracts.js';
import {
  ControlLoopPolicy,
  RUNTIME_OWNED_CONTROL_EVENTS,
  isRuntimeOwnedControlEvent,
} from '../../src/execution/control-loop-policy.js';

const revision = 'revision_1';

function event(type: ControlEvent['type']): ControlEvent {
  return {
    schemaVersion: 5,
    configurationRevision: revision,
    type,
    id: `event_${type}`,
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-11-09T00:00:00.000Z',
    sessionId: 'session_1',
    taskId: 'task_1',
  } as ControlEvent;
}

function snapshotFor(type: ControlEvent['type']): ControlSnapshot {
  const type2 = type === 'timer_tick'
    ? 'timer'
    : type === 'partition_conflict_observed'
      ? 'partition'
      : type === 'sandbox_lost'
        ? 'sandbox_recovery'
        : type === 'recovery_resolution_requested'
          ? 'recovery'
          : type === 'recovery_required_observed'
            ? 'recovery_required'
            : type === 'permission_requested' || type === 'permission_resolution_received'
              ? 'permission'
              : type === 'managed_service_requested'
                ? 'service_control'
                : type === 'task_remaining_work_retry_requested'
                  ? 'remaining_work_retry'
                  : 'dispatch';
  return { schemaVersion: 5, type: type2 } as unknown as ControlSnapshot;
}

const OWNER_POLICY_MODULES = [
  'src/execution/control-loop-policy.ts',
  'src/execution/dispatch-policy.ts',
  'src/execution/failure-retry-policy.ts',
  'src/execution/attempt-recovery-policy.ts',
  'src/execution/attempt-dispatch-plan.ts',
  'src/execution/permission-policy.ts',
  'src/execution/recovery-item-policy.ts',
  'src/execution/managed-service-policy.ts',
  'src/execution/remaining-work-retry-policy.ts',
];

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * ADR-0055 D3+D4+D5 ownership guard. The whole control round moved to the Task
 * Runtime, so no Kernel producer may exist, the Runtime policy must stay free of
 * storage/Session/Task Runtime ownership, and Task admission stays a direct
 * application instead of becoming a control event.
 */
describe('Task Runtime control-loop ownership', () => {
  it('keeps no Kernel policy producer in the source tree', () => {
    const contracts = source('src/control/control-contracts.ts');
    expect(contracts).not.toContain('export class ControlLoopPolicy');
    // D6-only transport: contracts, the decision factory and the shared guards.
    expect(contracts).toContain('export function decision');
    expect(contracts).toContain('export function guardControlDecision');
    expect(contracts).toContain('export function snapshotMatches');
    // The decider is constructed only in the account service cluster.
    for (const path of ['src/session/metaclaw-session.ts', 'src/session/conversation-session.ts']) {
      expect(source(path)).not.toContain('new ControlLoopPolicy(');
    }
  });

  it('routes every Kernel event through the single Runtime decider', () => {
    expect(RUNTIME_OWNED_CONTROL_EVENTS).toEqual(expect.arrayContaining([
      'dispatch_requested',
      'capacity_signal',
      'execution_outcome',
      'handoff_contract_failed',
      'execution_result_observed',
      'timer_tick',
      'task_resume_requested',
      'partition_conflict_observed',
      'sandbox_lost',
      'merge_conflict_observed',
      'generation_quiescence_observed',
      'recovery_resolution_requested',
      'recovery_required_observed',
      'permission_requested',
      'permission_resolution_received',
      'managed_service_requested',
      'task_remaining_work_retry_requested',
    ]));
    // Task admission is a direct owner application (D2), never a control event.
    expect(isRuntimeOwnedControlEvent('plan_proposed')).toBe(false);
    const policy = new ControlLoopPolicy();
    expect(() => policy.decide(event('plan_proposed'), snapshotFor('plan_proposed')))
      .toThrow(/admission owner/u);
  });

  it('decides a dispatch round with the Runtime policy and refuses an empty one', () => {
    const policy = new ControlLoopPolicy();
    const decision = policy.decide(
      event('dispatch_requested'),
      snapshotFor('dispatch_requested'),
    );
    // No Task fact in the snapshot: the policy refuses instead of silently
    // falling back to a Kernel producer.
    expect(decision.action.type).toBe('block_work');
    expect(decision.action).toMatchObject({ taskId: 'task_1' });
  });

  it('keeps Runtime policy free of storage, Session and Task Runtime ownership', () => {
    for (const path of OWNER_POLICY_MODULES) {
      const moduleSource = source(path);
      expect(moduleSource).not.toMatch(/from '\.\.\/(storage|session|account|gateway)\//u);
      expect(moduleSource).not.toContain('task-runtime-service');
      expect(moduleSource).not.toContain('control-workflow-repo');
      expect(moduleSource).not.toContain('control-decision-repo');
    }
  });

  it('composes the decider only from the account control services', () => {
    const composition = source('src/account/account-control-services.ts');
    expect(composition).toContain("import { ControlLoopPolicy } from '../execution/control-loop-policy.js';");
    expect(composition).toContain('controlLoop: new ControlLoopPolicy()');
  });
});
