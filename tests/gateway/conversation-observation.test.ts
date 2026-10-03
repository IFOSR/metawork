import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { ConversationObservationService, type ConversationObservationFrame, type ConversationObservationHandle } from '../../src/gateway/conversation-observation.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const handles: ConversationObservationHandle[] = [];
const databases: Database.Database[] = [];
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); databases.splice(0).forEach(db => db.close()); });

function fixture() {
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  const model = new SqliteConversationReadModel(db);
  const projector = new ConversationReadProjector(model);
  const subscriptions = new GatewaySubscriptions();
  let authorized = true;
  let source = 0;
  const service = new ConversationObservationService({ model, subscriptions, pollMs: 60_000,
    authorize: async accountId => authorized && accountId === 'account',
    sourceSequence: () => source, onError: error => { throw error; } });
  const append = (kind: GatewayEventEnvelope['kind'], payload: unknown, turnId = 'turn') => {
    const event: GatewayEventEnvelope = { protocolVersion: 2, accountId: 'account', conversationId: 'conv',
      turnId, requestId: 'request', sequence: ++source, eventId: `event_${source}`, kind, payload,
      occurredAt: '2026-10-02T00:00:00.000Z' };
    projector.apply('account', 'conv', [event], source);
    return event;
  };
  const open = async (send: (frame: ConversationObservationFrame) => boolean, cursor = model.head('account', 'conv') ?? undefined) => {
    const handle = await service.open({ accountId: 'account', conversationId: 'conv', observationId: 'view', send, cursor });
    handles.push(handle); return handle;
  };
  return { db, model, service, append, open, subscriptions, revoke: () => { authorized = false; } };
}

describe('shared Conversation observation', () => {
  it('locates an older Task with the native reply budget and checks authorization', async () => {
    const f = fixture();
    for (let index = 0; index < 60; index++) {
      f.append('turn_started', { userInput: '长提问'.repeat(1500) }, `turn_${index}`);
      f.append('trace_delta', { taskId: `task_${index}`, events: [] }, `turn_${index}`);
    }
    const page = await f.service.locate('account', 'conv', '', 'task_20', 40 * 1024);
    expect(page.turns.at(-1)?.id).toBe('turn_20');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(60 * 1024);
    expect(page.turns.some(turn => turn.id === 'turn_59')).toBe(false);
    await expect(f.service.locate('account', 'conv', '', 'missing', 40 * 1024)).rejects.toThrow('turn_not_found');
    f.revoke();
    await expect(f.service.locate('account', 'conv', '', 'task_20', 40 * 1024)).rejects.toThrow('conversation_denied');
  });

  it('subscribes before baseline and catches completion during the baseline send without replaying source history', async () => {
    const f = fixture();
    f.append('turn_started', { userInput: 'question' });
    const frames: ConversationObservationFrame[] = [];
    const handle = await f.service.open({ accountId: 'account', conversationId: 'conv', observationId: 'view',
      send: frame => {
        frames.push(frame);
        if (frame.kind === 'baseline') f.subscriptions.publish(f.append('final_answer', { lines: ['done'] }));
        return true;
      } });
    handles.push(handle);
    await handle.refresh();
    const patches = frames.filter(frame => frame.kind === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ change: { turn: { answer: 'done', status: 'completed' } } });
    expect(frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 64 * 1024)).toBe(true);
  });

  it('resumes durable changes committed before the publisher crashed', async () => {
    const f = fixture();
    f.append('turn_started', { userInput: 'question' });
    const cursor = f.model.head('account', 'conv')!;
    f.append('final_answer', { lines: ['durable answer'] });
    const frames: ConversationObservationFrame[] = [];
    await f.open(frame => { frames.push(frame); return true; }, cursor);
    expect(frames.filter(frame => frame.kind === 'baseline')).toHaveLength(0);
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'patch', change: expect.objectContaining({
      prevRevision: cursor.revision, turn: expect.objectContaining({ answer: 'durable answer' }),
    }) }));
  });

  it('resets an expired cursor with a bounded baseline and closes on revocation', async () => {
    const f = fixture();
    f.append('turn_started', { userInput: 'question' });
    const cursor = f.model.head('account', 'conv')!;
    f.append('final_answer', { lines: ['done'] });
    f.db.exec('DELETE FROM conversation_read_changes');
    const frames: ConversationObservationFrame[] = [];
    const handle = await f.open(frame => { frames.push(frame); return true; }, cursor);
    expect(frames[0]).toMatchObject({ kind: 'reset', reason: 'cursor_expired' });
    expect(frames[1]).toMatchObject({ kind: 'baseline' });
    f.revoke();
    await handle.refresh();
    expect(frames.at(-1)).toMatchObject({ kind: 'closed', reason: 'authorization_revoked' });
    const count = frames.length;
    f.subscriptions.publish(f.append('turn_started', { userInput: 'secret' }, 'other'));
    await handle.refresh();
    expect(frames).toHaveLength(count);
  });

  it('stops a slow consumer without preventing another observer or accumulating a queue', async () => {
    const f = fixture();
    f.append('turn_started', { userInput: 'question' });
    const cursor = f.model.head('account', 'conv')!;
    f.append('final_answer', { lines: ['done'] });
    let attempts = 0;
    const slow = await f.open(() => { attempts++; return false; }, cursor);
    const frames: ConversationObservationFrame[] = [];
    await f.open(frame => { frames.push(frame); return true; }, cursor);
    await slow.refresh();
    expect(attempts).toBe(1);
    expect(frames.some(frame => frame.kind === 'patch')).toBe(true);
    await expect(f.service.open({ accountId: 'other', conversationId: 'conv', observationId: 'bad', send: () => true }))
      .rejects.toThrow('conversation_denied');
  });
});
