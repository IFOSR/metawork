import { describe, expect, it } from 'vitest';
import {
  isValidWorkspaceId,
  normalizeWorkspaceDisplayName,
} from '../../src/workspace/workspace-types.js';

describe('workspace types', () => {
  it('accepts opaque workspace ids and rejects traversal', () => {
    expect(isValidWorkspaceId('workspace_01abc')).toBe(true);
    expect(isValidWorkspaceId('../escape')).toBe(false);
    expect(isValidWorkspaceId('workspace/a')).toBe(false);
  });

  it('normalizes bounded display names', () => {
    expect(normalizeWorkspaceDisplayName('  MetaWork  ')).toBe('MetaWork');
    expect(() => normalizeWorkspaceDisplayName('   ')).toThrow(/display name/u);
  });
});
