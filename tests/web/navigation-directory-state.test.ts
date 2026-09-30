import { describe, expect, it } from 'vitest';
import { NavigationDirectoryChanges, shouldActivateConversation } from '../../web/src/navigation-directory-state.js';

function row(id: string, title = id) {
  return { id, workspaceId: 'workspace_one', title, createdAt: 'now', updatedAt: 'now',
    latestTaskCreatedAt: '2026-09-30T00:00:00.000Z',
    active: false, archived: false, preview: title,
    activity: { state: 'planning' as const, taskId: null, updatedAt: 'now' }, workspace: null };
}
describe('navigation response reconciliation', () => {
  it('preserves removals and newer activity over delayed HTTP pages', () => {
    const changes = new NavigationDirectoryChanges();
    const start = changes.sequence;
    changes.observe({ workspaceId: 'workspace_one', conversationId: 'a', removed: true });
    changes.observe({ workspaceId: 'workspace_one', conversationId: 'b',
      changes: { activity: { state: 'idle', taskId: null, updatedAt: 'later' } } });
    const rows = changes.merge([row('a'), row('b')], 'workspace_one', '', start);
    expect(rows.map(item => item.id)).toEqual(['b']);
    expect(rows[0]?.activity?.state).toBe('idle');
  });
  it('applies the current search to newly created and renamed rows', () => {
    const changes = new NavigationDirectoryChanges();
    changes.observe({ workspaceId: 'workspace_one', conversationId: 'a', changes: row('a', 'unrelated') });
    changes.observe({ workspaceId: 'workspace_one', conversationId: 'b', changes: row('b', 'needle') });
    const rows = changes.merge([], 'workspace_one', 'needle', 0);
    expect(rows.map(item => item.id)).toEqual(['b']);
    const start = changes.sequence;
    changes.observe({ workspaceId: 'workspace_one', conversationId: 'b', changes: { title: 'renamed' } });
    expect(changes.merge(rows, 'workspace_one', 'needle', start)).toEqual([]);
  });
  it('sorts by the latest Task creation time instead of activity state', () => {
    const changes = new NavigationDirectoryChanges();
    const rows = changes.merge([
      {
        ...row('older-blocked'),
        latestTaskCreatedAt: '2026-09-29T23:00:00.000Z',
        activity: { state: 'blocked' as const, taskId: 'task_old', updatedAt: '2026-09-30T01:00:00.000Z' },
      },
      {
        ...row('newer-idle'),
        latestTaskCreatedAt: '2026-09-30T02:00:00.000Z',
        activity: { state: 'idle' as const, taskId: null, updatedAt: '2026-09-30T02:00:00.000Z' },
      },
    ], 'workspace_one', '', 0);

    expect(rows.map(item => item.id)).toEqual(['newer-idle', 'older-blocked']);
  });
  it('reattaches A when B is pending even if A is still the acknowledged active Conversation', () => {
    expect(shouldActivateConversation('a', 'a', 'b')).toBe(true);
    expect(shouldActivateConversation('a', 'a', null)).toBe(false);
    expect(shouldActivateConversation('b', 'a', null)).toBe(true);
  });
});
