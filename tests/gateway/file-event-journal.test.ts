import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  type GatewayEventEnvelope,
  type GatewayEventKind,
} from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';

let roots: string[] = [];

async function makeJournal(): Promise<FileEventJournal> {
  return (await makeJournalFixture()).journal;
}

async function makeJournalFixture(): Promise<{
  journal: FileEventJournal;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'event-journal-'));
  roots.push(root);
  return {
    journal: new FileEventJournal(root),
    root,
  };
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
    expect([...replay.deltas, ...replay.snapshot]
      .map(event => event.sequence)
      .sort((left, right) => left - right))
      .toEqual([1, 2, 3]);
  });

  it('serializes concurrent appends without losing or duplicating sequences', async () => {
    const journal = await makeJournal();
    const events = Array.from({ length: 40 }, (_, index) => (
      makeEvent(`concurrent_${index}`, 'trace_delta')
    ));

    const appended = await Promise.all(events.map(event => journal.append(event)));
    const replay = await journal.replay('local-default', 'conv_1');

    expect(new Set(appended.map(event => event.sequence)).size).toBe(events.length);
    expect(replay.deltas).toHaveLength(events.length);
    expect(replay.deltas.map(event => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
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
    expect(replay.deltas.map(event => event.eventId)).toEqual(['e2']);
    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e3']);
  });

  it('merges retained conversation deltas into one independently renderable snapshot', async () => {
    const journal = await makeJournal();
    await journal.append({
      ...makeEvent('e1', 'conversation_snapshot'),
      payload: { from: 0, lines: ['first'], currentTaskId: 'task_1' },
    });
    await journal.append({
      ...makeEvent('e2', 'conversation_snapshot'),
      payload: { from: 1, lines: ['second'], currentTaskId: 'task_1' },
    });

    const replay = await journal.replay('local-default', 'conv_1');

    expect(replay.snapshot).toHaveLength(1);
    expect(replay.snapshot[0]).toMatchObject({
      eventId: 'e2',
      sequence: 2,
      payload: {
        from: 0,
        lines: ['first', 'second'],
        currentTaskId: 'task_1',
        truncated: false,
      },
    });
    expect(replay.deltas).toEqual([]);
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

  it('redacts secret values and removes hidden reasoning fields before persistence', async () => {
    const journal = await makeJournal();
    await journal.append({
      ...makeEvent('e1', 'trace_delta'),
      payload: {
        summary: 'authorization=Bearer private-token api_key=sk-secret123',
        prompt: 'raw planner prompt',
        reasoning: 'hidden chain of thought',
        nested: { clientSecret: 'sensitive-value', safe: 'visible' },
      },
    });

    const replay = await journal.replay('local-default', 'conv_1');
    const serialized = JSON.stringify(replay.deltas[0]?.payload);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('visible');
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('sk-secret123');
    expect(serialized).not.toContain('raw planner prompt');
    expect(serialized).not.toContain('hidden chain of thought');
    expect(serialized).not.toContain('sensitive-value');
  });

  it('rejects payloads above the public event byte limit', async () => {
    const journal = await makeJournal();
    await expect(journal.append({
      ...makeEvent('e1', 'final_answer'),
      payload: { lines: ['x'.repeat(MAX_GATEWAY_EVENT_PAYLOAD_BYTES + 1)] },
    })).rejects.toThrow('payload exceeds');
  });

  it('sanitizes historical version-1 payloads before enforcing the byte limit', async () => {
    const { journal, root } = await makeJournalFixture();
    const path = join(root, 'local-default', 'conv_1.json');
    await mkdir(join(root, 'local-default'), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      lastSequence: 1,
      events: [{
        ...makeEvent('e1', 'final_answer'),
        sequence: 1,
        payload: {
          prompt: 's'.repeat(MAX_GATEWAY_EVENT_PAYLOAD_BYTES + 1),
          lines: ['safe answer'],
        },
      }],
    }));

    const replay = await journal.replay('local-default', 'conv_1');

    expect(replay.snapshot).toHaveLength(1);
    expect(replay.snapshot[0]?.payload).toEqual({ lines: ['safe answer'] });
  });

  it('keeps an oversized historical answer replayable with a bounded tail', async () => {
    const { journal, root } = await makeJournalFixture();
    const path = join(root, 'local-default', 'conv_1.json');
    await mkdir(join(root, 'local-default'), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      lastSequence: 1,
      events: [{
        ...makeEvent('e1', 'final_answer'),
        sequence: 1,
        payload: {
          lines: ['discarded'.repeat(10_000), 'visible tail'],
        },
      }],
    }));

    const replay = await journal.replay('local-default', 'conv_1');

    expect(replay.snapshot[0]?.payload).toEqual({
      lines: ['visible tail'],
      truncated: true,
    });
  });

  it('resets a stale cursor to a current snapshot and replays only later deltas', async () => {
    const journal = await makeJournal();
    for (let sequence = 1; sequence <= 201; sequence += 1) {
      const event = sequence === 2
        ? {
            ...makeEvent('e2', 'conversation_snapshot'),
            payload: { from: 12, lines: ['restored output'], currentTaskId: 'task_1' },
          }
        : sequence === 3
          ? {
              ...makeEvent('e3', 'task_projection'),
              payload: { currentTaskId: 'task_1', runtimeState: 'running' },
            }
          : makeEvent(`e${sequence}`, 'trace_delta');
      await journal.append(event);
    }

    const replay = await journal.replay('local-default', 'conv_1', 0);

    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e2', 'e3']);
    expect(replay.snapshot[0]?.payload).toEqual({
      from: 0,
      lines: ['restored output'],
      currentTaskId: 'task_1',
      truncated: true,
    });
    expect(replay.deltas[0]?.sequence).toBe(4);
    expect(replay.deltas.at(-1)?.sequence).toBe(201);
  });

  it('returns the terminal snapshot after retention when no cursor is supplied', async () => {
    const journal = await makeJournal();
    for (let sequence = 1; sequence <= 201; sequence += 1) {
      await journal.append(makeEvent(
        `e${sequence}`,
        sequence === 201 ? 'final_answer' : 'trace_delta',
      ));
    }

    const replay = await journal.replay('local-default', 'conv_1');

    expect(replay.lastSequence).toBe(201);
    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e201']);
    expect(replay.deltas[0]?.sequence).toBe(2);
  });

  it('accepts a cursor immediately before the retained history and returns the terminal snapshot', async () => {
    const journal = await makeJournal();
    for (let sequence = 1; sequence <= 201; sequence += 1) {
      await journal.append(makeEvent(
        `e${sequence}`,
        sequence === 201 ? 'final_answer' : 'trace_delta',
      ));
    }

    const replay = await journal.replay('local-default', 'conv_1', 1);

    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e201']);
    expect(replay.deltas[0]?.sequence).toBe(2);
  });
});
