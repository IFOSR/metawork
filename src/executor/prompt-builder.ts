import type { ExecutorInput } from './adapter.js';

/** The only production renderer for an Executor's attempt-scoped context. */
export function buildExecutorContextPrompt(input: ExecutorInput): string {
  const { context } = input;
  const lines = [
    '[MetaClaw Subtask Execution Context v1]',
    '',
    'Boundary rules:',
    '- The Task goal below is background only. It is not an instruction to execute the whole Task.',
    '- Execute only currentSubtask.goal.',
    '- Other graph nodes are out of scope. Do not execute or anticipate their full goals.',
    '- Dependency data is available only through incomingHandoffs.',
    '- Finish with non-empty Markdown followed by exactly one completion marker and strict JSON until EOF.',
    '',
    `Task background: #${context.taskBackground.id} ${context.taskBackground.title}`,
    `Background goal: ${context.taskBackground.goal}`,
    '',
    `Current Subtask: #${context.currentSubtask.id} ${context.currentSubtask.title}`,
    `Operative goal: ${context.currentSubtask.goal}`,
    `Expected output: ${context.currentSubtask.expectedOutput}`,
    'Acceptance contract:',
    JSON.stringify(context.currentSubtask.acceptance, null, 2),
    '',
    'Incoming direct handoffs:',
    JSON.stringify(context.incomingHandoffs.map(handoff => ({
      fromSubtaskId: handoff.fromSubtaskId,
      items: handoff.items,
    })), null, 2),
    '',
    'Outgoing handoff requirements (do not infer downstream goals):',
    JSON.stringify(context.outgoingHandoffRequirements, null, 2),
    '',
    'Planner-selected evidence:',
    JSON.stringify(context.selectedEvidence.map(evidence => ({
      evidenceId: evidence.evidenceId,
      title: evidence.title,
      content: evidence.content,
      truncated: evidence.truncated,
    })), null, 2),
    '',
    'Out-of-scope graph nodes (IDs and titles only):',
    JSON.stringify(context.outOfScopeSiblings, null, 2),
    '',
    `Working directory: ${context.workspaceContext.workingDirectory}`,
    `Authorized target paths: ${context.workspaceContext.targetPaths.join(', ') || '(none)'}`,
    `Evidence tool: ${context.evidenceTools.availability} — ${context.evidenceTools.reason}`,
    `Attempt identity: ${JSON.stringify(context.identity)}`,
    '',
    'Completion protocol:',
    context.completionContract.marker,
    '{"schemaVersion":1,"subtaskId":"<authorized id>","acceptanceEvidence":[{"key":"<exact acceptance key>","evidence":["..."]}],"artifacts":[],"handoffs":[]}',
    'The marker shown above is illustrative. Emit it exactly once, only at the end of your final response.',
  ];
  return lines.join('\n');
}
