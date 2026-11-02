import { describe, expect, it } from 'vitest';
import { supportsSharedWorkspaceRead } from '../../src/work-graph/workspace-effect.js';

describe('Workspace read admission', () => {
  const reader = {id: 'research', workspaceEffect: 'read_only' as const, deliveryKind: 'report' as const, fileOutputs: []};
  it('admits readers in a mixed graph without requiring every node to be read-only', () => {
    const writer = {dependencies: [{fromSubtaskId: 'research', requiredItems: [{key: 'findings', type: 'text' as const, description: 'findings'}]}]};
    expect(supportsSharedWorkspaceRead(reader, [writer])).toBe(true);
    expect(supportsSharedWorkspaceRead(reader, [{dependencies: [{fromSubtaskId: 'unrelated', requiredItems: [{key: 'file', type: 'artifact', description: 'file'}]}]}])).toBe(true);
  });
  it('retains exclusive admission for unknown effects, file delivery and artifact handoffs', () => {
    for (const node of [{...reader, workspaceEffect: undefined}, {...reader, workspaceEffect: 'unknown' as const},
      {...reader, workspaceEffect: 'write' as const}, {...reader, fileOutputs: undefined},
      {...reader, fileOutputs: ['report.md']}, {...reader, deliveryKind: 'edit' as const}]) {
      expect(supportsSharedWorkspaceRead(node, [])).toBe(false);
    }
    expect(supportsSharedWorkspaceRead(reader, [{dependencies: [{fromSubtaskId: reader.id,
      requiredItems: [{key: 'file', type: 'artifact', description: 'file'}]}]}])).toBe(false);
  });
});
