import { describe, expect, it, vi } from 'vitest';
import { planWithoutClient } from '../../src/session/detached-recovery-planner.js';
import type { PlannerHostBridgeSession } from '../../src/tui-bridge/planner-host-bridge.js';
import { buildPlannerConfigurationView } from '../../src/configuration/projections.js';
import { spanSnapshot } from '../support/span-configuration.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

it('validates through an isolated temporary host and unregisters after planning', async () => {
  let host!: PlannerHostBridgeSession;
  const unregister = vi.fn();
  const registerSession = vi.fn((_id: string, session: PlannerHostBridgeSession) => { host = session; return unregister; });
  const proposal = workGraphPlan({ goal: 'Fix parser', capabilityClass: 'code_edit', contextRefs: [] });
  proposal.task.binding = 'reference'; proposal.task.taskId = 'task';
  proposal.workGraph!.subtasks[0]!.executorBindings[0]!.modelSelection = { mode: 'agent-class-default' };
  const run = vi.fn(async (_prompt, context, purpose) => {
    expect(purpose).toBe('validation');
    expect(context.request.sessionId).not.toBe('owner');
    expect(context.request.conversationId).toBe('conversation');
    const submission = { sessionId: context.request.sessionId, turnId: 'turn', submissionId: 'submission',
      userInput: context.userInput, plan: proposal };
    const rejected = await host.submitPlannerProposal(submission, 'kernel');
    expect(rejected.status).toBe('rejected');
    const proposalResult = await host.submitPlannerProposal(submission, purpose);
    expect(proposalResult.status, JSON.stringify(proposalResult)).toBe('accepted');
    return { proposalResult, submittedPlan: proposal, toolCalls: [] };
  });
  const result = await planWithoutClient({ context: {
    userInput: 'Fix parser', request: { sessionId: 'owner', conversationId: 'conversation', source: 'recovery' },
    configuration: buildPlannerConfigurationView(spanSnapshot()), pendingAuthorizationRequest: null, timeoutMs: 1000,
  }, runner: { run, abortSession: vi.fn() } as never, registerSession });
  expect(result.task.taskId).toBe('task');
  expect(unregister).toHaveBeenCalledOnce();
});
