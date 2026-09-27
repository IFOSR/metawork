import { expect, it } from 'vitest';
import { mergeNewestHistoryPage } from '../../web/src/navigation-history-state.js';
import type { WebSessionRecord } from '../../web/src/api/session-types.js';

function record(ids: string[], cursor: string | null = null, id = 'conv_one'): WebSessionRecord {
  return { version: 1, session: { id }, turns: ids.map(id => ({ id })), historyCursor: cursor } as WebSessionRecord;
}

it('preserves explicitly loaded older pages and their cursor when the newest page refreshes', () => {
  const current = record(['oldest', 'older', 'recent', 'last'], 'older-page');
  const incoming = record(['recent', 'last', 'new'], 'recent-page');
  const merged = mergeNewestHistoryPage(current, incoming);
  expect(merged.turns.map(turn => turn.id)).toEqual(['oldest', 'older', 'recent', 'last', 'new']);
  expect(merged.historyCursor).toBe('older-page');
  expect(mergeNewestHistoryPage(record(['earliest', 'last']), record(['last', 'new'], 'more')).historyCursor).toBeNull();
});

it('does not join disconnected ranges or another Conversation and silently skip the intervening history', () => {
  const incoming = record(['new'], 'more');
  expect(mergeNewestHistoryPage(record(['old']), incoming)).toBe(incoming);
  expect(mergeNewestHistoryPage(record(['old', 'new'], null, 'another'), incoming)).toBe(incoming);
});
