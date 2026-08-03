import { describe, expect, it } from 'vitest';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';

function input() {
  return {
    context: {
      taskBackground: { id: 'task', title: 'Task', goal: 'Top-level goal', instruction: 'background_only' as const },
      currentSubtask: {
        id: 'a',
        title: 'A',
        goal: 'Only do A',
        expectedOutput: 'summary' as const,
        acceptance: [
          { key: 'done', description: 'done', requiredEvidence: [] },
          { key: 'verified', description: 'verified', requiredEvidence: [] },
        ],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [{ toSubtaskId: 'b', requiredItems: [{ key: 'summary', type: 'text' as const, description: 'summary' }] }],
      selectedEvidence: [{ ref: { kind: 'current_user_input' as const }, evidenceId: 'e1', title: 'Current input', content: 'selected evidence only', truncated: false }],
      outOfScopeSiblings: [{ id: 'b', title: 'B' }],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'e', taskId: 'task', subtaskId: 'a', attemptId: 'attempt', workUnitId: 'wu' },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->' as const, schemaVersion: 2 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'unit test' },
    },
  };
}

describe('Subtask execution prompt layering', () => {
  it('marks the Task goal background-only and the Subtask goal operative', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('Background goal: Top-level goal');
    expect(prompt).toContain('Operative goal: Only do A');
    expect(prompt).toContain('background only');
  });

  it('renders only selected evidence, direct handoffs, sibling identity and completion contract', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('selected evidence only');
    expect(prompt).toContain('toSubtaskId');
    expect(prompt).toContain('"title": "B"');
    expect(prompt).toContain('<!-- metaclaw:completion:v2 -->');
    expect(prompt).not.toContain('conversationHistory');
    expect(prompt).not.toContain('executionContextBundle');
  });

  it('renders a concrete completion template with every authorized acceptance key', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('"subtaskId":"a"');
    expect(prompt).toContain('"key":"done"');
    expect(prompt).toContain('"key":"verified"');
    expect(prompt).not.toContain('<exact acceptance key>');
    expect(prompt).toContain('property name "key" is literal ASCII schema syntax');
  });
});
