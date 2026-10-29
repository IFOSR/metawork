import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const promptPath = new URL(
  '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts',
  import.meta.url,
);

describe('Planner decomposition policy', () => {
  it('tells the Planner to split independent streams and add a synthesis node', async () => {
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain('Decompose by independent work');
    expect(prompt).toContain('one subtask per independent stream as parallel roots');
    expect(prompt).toContain('synthesis/submission subtask that depends on them');
    expect(prompt).toContain('Keep exactly one subtask only when the work is one atomic deliverable');
    expect(prompt).toContain('work_graph_quality');
  });

  it('keeps "one graph per turn" distinct from "one node"', async () => {
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain('one graph per turn; the graph itself may hold several subtasks');
    expect(prompt).not.toContain('submit one focused `plan_work_graph`');
  });
});
