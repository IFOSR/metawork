import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/components/', import.meta.url);

describe('Detailed conversation view', () => {
  it('renders safe detailed Planner, Kernel, Executor, verification, and final answer sections', async () => {
    const [view, turn, narrative, step] = await Promise.all([
      readFile(new URL('ConversationView.tsx', root), 'utf8'),
      readFile(new URL('ConversationTurn.tsx', root), 'utf8'),
      readFile(new URL('ExecutionNarrative.tsx', root), 'utf8'),
      readFile(new URL('ExecutionStep.tsx', root), 'utf8'),
    ]);

    expect(view).toContain('ConversationTurnView');
    expect(turn).toContain("turn.status !== 'running'");
    expect(turn).toContain('MarkdownContent');
    expect(turn).not.toContain('<strong>最终答案</strong>');
    expect(narrative).toContain('Planner');
    expect(narrative).toContain('授权与路由');
    expect(narrative).toContain('执行');
    expect(narrative).toContain('验证与交付');
    expect(narrative).toContain('executionTimeline');
    expect(narrative).toContain('progressHistory');
    expect(narrative).toContain('hasStageContent');
    expect(step).toContain('<details');
    expect(step).toContain('event.details');
    expect(step).not.toContain('rawPrompt');
    expect(step).not.toContain('reasoningText');
  });
});
