import { describe, expect, it } from 'vitest';
import { buildCanonicalSubtaskIdentityMap } from '../../src/work-graph/subtask-identity.js';

describe('canonical Work Graph Subtask identity', () => {
  it('maps proposal IDs to deterministic Runtime IDs', () => {
    const aliases = buildCanonicalSubtaskIdentityMap(
      'task_abc',
      1,
      [{ id: 'research' }, { id: 'render-html' }],
    );

    expect(aliases.get('research')).toBe('task_abc_r1_research');
    expect(aliases.get('render-html')).toBe('task_abc_r1_render-html');
  });

  it('preserves canonical IDs and resolves normalized collisions deterministically', () => {
    const aliases = buildCanonicalSubtaskIdentityMap(
      'task_abc',
      2,
      [
        { id: 'task_abc_r2_existing' },
        { id: 'render html' },
        { id: 'render/html' },
        { id: '///' },
      ],
    );

    expect(aliases.get('task_abc_r2_existing')).toBe('task_abc_r2_existing');
    expect(aliases.get('render html')).toBe('task_abc_r2_render_html');
    expect(aliases.get('render/html')).toBe('task_abc_r2_render_html_2');
    expect(aliases.get('///')).toBe('task_abc_r2_subtask_execute');
  });
});
