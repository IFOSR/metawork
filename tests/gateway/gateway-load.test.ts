import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('gateway load bounds', () => {
  it('bounds the conversation mailbox and rejects overflow', () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mailbox = new ConversationInputMailbox({
      execute: async () => { await gate; },
      maxQueueSize: 2,
    });

    mailbox.submit({ requestId: 'req_1', idempotencyKey: 'idem_1' });
    mailbox.submit({ requestId: 'req_2', idempotencyKey: 'idem_2' });
    const rejected = mailbox.submit({ requestId: 'req_3', idempotencyKey: 'idem_3' });

    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('busy');
    release!();
  });

  it('retains a bounded event journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'load-journal-'));
    roots.push(root);
    const journal = new FileEventJournal(join(root, 'journal'));

    // 追加超过保留上限的事件。
    for (let index = 0; index < 250; index += 1) {
      await journal.append({
        protocolVersion: 1,
        eventId: `evt_${index}`,
        sequence: 0,
        accountId: 'local-default',
        conversationId: 'conv_1',
        requestId: null,
        turnId: null,
        kind: 'trace_delta',
        payload: {},
        occurredAt: '2026-08-18T00:00:00.000Z',
      });
    }

    const replay = await journal.replay('local-default', 'conv_1');
    // 保留上限为 200。
    expect(replay.deltas.length).toBeLessThanOrEqual(200);
  });
});
