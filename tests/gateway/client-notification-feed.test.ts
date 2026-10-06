import { describe, expect, it } from 'vitest';
import { ClientNotificationFeed } from '../../src/gateway/client-notification-feed.js';

describe('Bounded client notification facts', () => {
  const event = { workspaceId: 'workspace', conversationId: 'conversation', taskId: 'task', kind: 'approval' as const };
  it('uses stable identities, account isolation and no historical startup storm', () => {
    const feed = new ClientNotificationFeed();
    feed.publish('account', event, 'before-start');
    const head = feed.read('account', null);
    expect(head.events).toEqual([]);
    feed.publish('account', event, 'revision-2'); feed.publish('account', event, 'revision-2');
    expect(feed.read('account', head.cursor).events).toHaveLength(1);
    expect(feed.read('another-account', head.cursor).events).toEqual([]);
  });
  it('bounds pages and resets stale or future cursors', () => {
    const feed = new ClientNotificationFeed(); const head = feed.read('account', null);
    for (let i = 0; i < 512; i++) feed.publish('account', event, String(i));
    expect(feed.read('account', head.cursor).events).toHaveLength(64);
    feed.publish('account', event, 'overflow');
    expect(feed.read('account', head.cursor).reset).toBe(true);
    expect(feed.read('account', head.cursor.replace(/:0$/, ':900')).reset).toBe(true);
  });
});
