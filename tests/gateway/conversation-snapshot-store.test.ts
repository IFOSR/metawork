import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_SNAPSHOT_BYTES, projectConversationSnapshot,
} from '../../src/gateway/conversation-snapshot-store.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

function event(sequence: number, turnId: string, kind: GatewayEventEnvelope['kind']): GatewayEventEnvelope {
  return {
    protocolVersion: 2, accountId: 'local-default', conversationId: 'conv_one',
    requestId: `req_${turnId}`, turnId, eventId: `event_${sequence}`, sequence, kind,
    payload: { lines: ['safe answer'] }, occurredAt: '2026-09-26T00:00:00Z',
  };
}

describe('bounded Conversation snapshot projection', () => {
  it('bounds a trace-only snapshot after merging individually valid large deltas', () => {
    const deltas = Array.from({ length: 12 }, (_, n) => ({
      ...event(n + 1, 'current', 'trace_delta'),
      payload: {
        turnId: 'current',
        events: [{ id: `trace_${n}`, sequence: n + 1, summary: 'x'.repeat(60_000) }],
      },
    }));
    const snapshot = projectConversationSnapshot([], deltas);
    expect(snapshot).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_CONVERSATION_SNAPSHOT_BYTES);
    expect(snapshot[0]?.payload).toMatchObject({
      replay: true,
      events: [{ id: 'trace_11', sequence: 12 }],
    });
    let incremental: GatewayEventEnvelope[] = [];
    for (const delta of deltas) {
      incremental = projectConversationSnapshot(incremental, [delta]);
      expect(Buffer.byteLength(JSON.stringify(incremental))).toBeLessThanOrEqual(MAX_CONVERSATION_SNAPSHOT_BYTES);
    }
    expect(incremental).toEqual(snapshot);
  });

  it('keeps independently keyed artifacts and result summaries from the same Turn', () => {
    const snapshot = projectConversationSnapshot([], [
      event(1, 'current', 'turn_started'),
      { ...event(2, 'current', 'artifact'), payload: { artifactId: 'artifact_a' } },
      { ...event(3, 'current', 'artifact'), payload: { artifactId: 'artifact_b' } },
      { ...event(4, 'current', 'result_delivery_available'), payload: { resultId: 'result_a' } },
      { ...event(5, 'current', 'result_delivery_available'), payload: { resultId: 'result_b' } },
    ]);
    expect(snapshot.filter(item => item.kind === 'artifact')).toHaveLength(2);
    expect(snapshot.filter(item => item.kind === 'result_delivery_available')).toHaveLength(2);
  });

  it('never resurrects the tail of an omitted oversized result on a subsequent append', () => {
    const chunks = Array.from({ length: 6 }, (_, n) => ({
      ...event(n + 3, 'current', 'result_chunk'),
      payload: { resultId: 'big', offset: n * 60_000, chunk: 'x'.repeat(60_000) },
    }));
    let snapshot = projectConversationSnapshot([], [
      event(1, 'current', 'turn_started'),
      { ...event(2, 'current', 'result_delivery_available'), payload: { resultId: 'big' } },
      ...chunks,
    ]);
    expect(snapshot.filter(item => item.kind === 'result_chunk')).toHaveLength(0);
    snapshot = projectConversationSnapshot(snapshot, [
      { ...event(10, 'current', 'result_chunk'), payload: { resultId: 'big', offset: 360_000, chunk: 'tail' } },
      { ...event(11, 'current', 'result_completed'), payload: { resultId: 'big' } },
    ]);
    expect(snapshot.filter(item => item.kind === 'result_chunk')).toHaveLength(0);
    expect(snapshot.some(item => item.kind === 'turn_started')).toBe(true);
  });

  it('does not revive a partial result after its omission metadata was pruned', () => {
    const snapshot = projectConversationSnapshot([event(1, 'current', 'turn_started')], [
      { ...event(10, 'current', 'result_chunk'), payload: { resultId: 'big', offset: 360_000, chunk: 'tail' } },
      { ...event(11, 'current', 'result_completed'), payload: { resultId: 'big', byteLength: 360_004 } },
    ]);
    expect(snapshot.filter(item => item.kind === 'result_chunk')).toEqual([]);
    expect(snapshot.find(item => item.kind === 'result_completed')?.payload)
      .toMatchObject({ snapshotContentOmitted: true });
  });

  it('does not turn historical directory or query responses into an attach snapshot', () => {
    const snapshot = projectConversationSnapshot([], [
      { ...event(1, '', 'workspace_directory_snapshot'), turnId: null },
      { ...event(2, '', 'workspace_activity_changed'), turnId: null },
      { ...event(3, '', 'conversation_history_page'), turnId: null },
    ]);
    expect(snapshot).toEqual([]);
  });

  it('does not let a late event from an older Turn displace the currently active Turn', () => {
    let snapshot = projectConversationSnapshot([], [
      event(1, 'old', 'turn_started'), event(2, 'old', 'final_answer'),
      event(3, 'current', 'turn_started'),
    ]);
    snapshot = projectConversationSnapshot(snapshot, [event(4, 'old', 'final_answer')]);
    expect(snapshot.some(item => item.turnId === 'current' && item.kind === 'turn_started')).toBe(true);
    expect(snapshot.some(item => item.turnId === 'old')).toBe(false);
  });

  it('preserves the latest intake and terminal answer while bounding repeated terminal enrichments', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      ...event(i + 2, 'current', 'final_answer'), payload: { lines: ['x'.repeat(60_000)] },
    }));
    const snapshot = projectConversationSnapshot([event(1, 'current', 'turn_started')], events);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(270_000);
    expect(snapshot.some(item => item.kind === 'turn_started')).toBe(true);
    expect(snapshot.at(-1)?.sequence).toBe(31);
  });
});
