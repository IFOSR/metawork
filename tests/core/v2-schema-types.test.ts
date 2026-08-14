import { describe, expect, it } from 'vitest';
import type { GuidanceProposal } from '../../src/core/types.js';

describe('V2 core types', () => {
  it('supports proposal shapes', () => {
    const proposal: GuidanceProposal = {
      id: 'guid_1',
      trigger: 'startup',
      taskId: 'task_1',
      actionType: 'resume_task',
      recommendedAction: '恢复任务 #task_1',
      reasons: ['材料已齐', '上次下一步明确'],
      confidence: 0.92,
      requiresConfirmation: true,
      proposalPayload: { taskId: 'task_1' },
      expiresAt: '2026-04-20T01:00:00Z',
      createdAt: '2026-04-20T00:00:00Z',
    };

    expect(proposal.actionType).toBe('resume_task');
  });
});
