import { describe, expect, it, vi } from 'vitest';
import { type ControlEvent, type ControlSnapshot } from '../../src/control/control-contracts.js';
import { ControlLoopPolicy } from '../../src/execution/control-loop-policy.js';
import { withPlanAdmission } from '../../src/execution/plan-admission-ledger-adapter.js';
import { event, snapshot } from '../support/plan-admission-fixture.js';
import { workGraphPlan, taskControlPlan } from '../support/planning-agent-plans.js';

function ledgerRequest(): Extract<ControlEvent, { type: 'plan_proposed' }> {
  return { ...structuredClone(event), schemaVersion: 5, type: 'plan_proposed', correlationId: 'turn_1', causationId: null };
}
function ledgerFacts(): Extract<ControlSnapshot, { type: 'plan_admission' }> {
  const { configuration, ...facts } = structuredClone(snapshot);
  return { ...facts, schemaVersion: 5, type: 'plan_admission', kernelConfiguration: configuration };
}

describe('transitional plan admission persistence adapter', () => {
  it('handles admission without calling ControlLoopPolicy and preserves the durable operation identity', () => {
    const kernel = { decide: vi.fn(() => { throw new Error('Kernel must not interpret plans'); }) };
    const result = withPlanAdmission(kernel).decide(ledgerRequest(), ledgerFacts());
    expect(kernel.decide).not.toHaveBeenCalled();
    expect(result).toEqual({
      schemaVersion: 5, configurationRevision: event.configurationRevision,
      id: `decision_${event.id}`, eventId: event.id,
      action: { type: 'no_op' }, reason: 'no runtime action required',
    });
  });

  it('preserves closed entitlement checks for productive plans and task controls', () => {
    const adapter = withPlanAdmission(new ControlLoopPolicy());
    const facts = ledgerFacts();
    facts.productionAuthorization = { allowed: false, reason: 'license_closed' };
    const input = ledgerRequest();
    input.proposal = workGraphPlan({ goal: 'Work' });
    input.proposal.workGraph!.subtasks[0]!.contextRefs = [];
    expect(adapter.decide(input, facts)).toMatchObject({
      action: { type: 'block_work', preserveSubtaskState: true }, reason: 'license_closed',
    });
    input.proposal = taskControlPlan({ control: 'resume_task', taskId: 'task_1' });
    facts.tasks = [{ id: 'task_1', status: 'needs_action' }];
    expect(adapter.decide(input, facts).action.type).toBe('block_work');
    expect(adapter.decide(ledgerRequest(), facts).action.type).toBe('no_op');
  });

  it('refuses mismatched facts and forbids direct Kernel admission', () => {
    const kernel = new ControlLoopPolicy();
    const wrong = { schemaVersion: 5, type: 'recovery_required', task: null, recoveryItemId: 'missing', reason: 'missing' } as const;
    expect(withPlanAdmission(kernel).decide(ledgerRequest(), wrong)).toMatchObject({ action: { type: 'block_work' }, reason: 'event and snapshot do not match' });
    expect(() => kernel.decide(ledgerRequest(), ledgerFacts())).toThrow('Task Runtime admission owner');
  });

  it('leaves the surviving Kernel families with their existing owner', () => {
    const kernel = new ControlLoopPolicy();
    const spy = vi.spyOn(kernel, 'decide');
    const input: ControlEvent = { ...ledgerRequest(), type: 'recovery_required_observed', taskId: 'task_1', recoveryItemId: 'recovery_1', reason: 'unknown effect' };
    const facts: ControlSnapshot = { schemaVersion: 5, type: 'recovery_required', task: { id: 'task_1', status: 'running' }, recoveryItemId: 'recovery_1', reason: 'unknown effect' };
    const result = withPlanAdmission(kernel).decide(input, facts);
    expect(spy).toHaveBeenCalledOnce();
    expect(result.action.type).toBe('block_work');
  });
});
