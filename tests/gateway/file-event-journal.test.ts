import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayEventKind } from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';

let roots: string[] = [];

async function makeJournal(): Promise<FileEventJournal> {
  const root = await mkdtemp(join(tmpdir(), 'event-journal-'));
  roots.push(root);
  return new FileEventJournal(root);
}

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

function makeEvent(
  id: string,
  kind: GatewayEventKind,
  accountId = 'local-default',
  conversationId = 'conv_1',
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: id,
    sequence: 0,
    accountId,
    conversationId,
    requestId: null,
    turnId: null,
    kind,
    payload: {},
    occurredAt: '2026-08-18T00:00:00.000Z',
  };
}

describe('FileEventJournal', () => {
  it('assigns monotonic sequences', async () => {
    const journal = await makeJournal();
    await journal.append(makeEvent('e1', 'turn_started'));
    await journal.append(makeEvent('e2', 'trace_delta'));
    await journal.append(makeEvent('e3', 'final_answer'));

    const replay = await journal.replay('local-default', 'conv_1');
    expect(replay.deltas.map(event => event.sequence)).toEqual([1, 2, 3]);
  });

  it('ignores duplicate event ids', async () => {
    const journal = await makeJournal();
    await journal.append(makeEvent('e1', 'turn_started'));
    await journal.append(makeEvent('e1', 'turn_started'));

    const replay = await journal.replay('local-default', 'conv_1');
    expect(replay.deltas).toHaveLength(1);
  });

  it('replays deltas after a cursor and returns terminal snapshots', async () => {
    const journal = await makeJournal();
    await journal.append(makeEvent('e1', 'turn_started'));
    await journal.append(makeEvent('e2', 'trace_delta'));
    await journal.append(makeEvent('e3', 'final_answer'));

    const replay = await journal.replay('local-default', 'conv_1', 1);
    expect(replay.lastSequence).toBe(3);
    expect(replay.deltas.map(event => event.eventId)).toEqual(['e2', 'e3']);
    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e3']);
  });

  it('isolates conversations', async () => {
    const journal = await makeJournal();
    await journal.append(makeEvent('e1', 'turn_started', 'local-default', 'conv_1'));
    await journal.append(makeEvent('e2', 'turn_started', 'local-default', 'conv_2'));

    expect((await journal.replay('local-default', 'conv_1')).deltas.map(event => event.eventId)).toEqual(['e1']);
    expect((await journal.replay('local-default', 'conv_2')).deltas.map(event => event.eventId)).toEqual(['e2']);
  });

  it('persists across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-journal-persist-'));
    roots.push(root);

    const journal1 = new FileEventJournal(root);
    await journal1.append(makeEvent('e1', 'turn_started'));

    const journal2 = new FileEventJournal(root);
    const replay = await journal2.replay('local-default', 'conv_1');
    expect(replay.deltas.map(event => event.eventId)).toEqual(['e1']);
  });

  it('rejects unsafe account or conversation ids', async () => {
    const journal = await makeJournal();
    await expect(journal.append(makeEvent('e1', 'turn_started', '../evil', 'conv_1'))).rejects.toThrow();
    await expect(journal.append(makeEvent('e1', 'turn_started', 'local-default', '../evil'))).rejects.toThrow();
  });
});
