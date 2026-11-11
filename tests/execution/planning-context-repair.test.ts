import { describe, expect, it, vi } from 'vitest';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { authorizePlanAdmission } from '../../src/execution/plan-admission-policy.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import { event, snapshot } from '../support/plan-admission-fixture.js';

function proposal() {
  const plan = workGraphPlan({ goal: 'Compare local and upstream architecture' });
  delete (plan as unknown as Record<string, unknown>).response;
  for (const subtask of plan.workGraph!.subtasks) delete (subtask as unknown as Record<string, unknown>).executorBindings;
  plan.workGraph!.subtasks[0]!.contextRefs = [{ kind: 'interaction', interactionId: 'conv_1', side: 'user' }];
  return plan;
}

describe('invalid model-generated context references', () => {
  it('returns repair feedback before saving a proposal or asking the user', async () => {
    const execute = vi.fn();
    const session = new ConversationSession({ conversationId: 'conv_1', plannerSessionId: 'planner_1',
      runtimePort: { accountId: 'local-default' } as never,
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }), executeUserInput: execute });
    const result = await session['submitValidatedPlannerProposal']('Compare architecture', proposal());
    expect(result).toMatchObject({ status: 'rejected', rejectionType: 'validation', kernel: null });
    expect('issues' in result && result.issues.join(' ')).toContain('current_user_input');
    expect(execute).not.toHaveBeenCalled();
    expect(session.getOutput()).toEqual([]);
  });

  it('fails closed at admission without turning an internal error into clarification', () => {
    const result = authorizePlanAdmission({ ...event, proposal: proposal() }, { ...snapshot, eligibleContextRefKeys: [] });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(result.reason).toContain('unqualified context refs');
  });
});
