import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationRoutingService, NotificationDestinationRevoked, notificationFromTurn, type NotificationFact, type NotificationJob } from '../../src/delivery/notification-routing.js';
import { SqliteNotificationRoutingStore } from '../../src/storage/notification-routing-repo.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { runMigrations } from '../../src/storage/migrations.js';

const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function fixture() {
  const db = new Database(':memory:'); dbs.push(db); runMigrations(db);
  const store = new SqliteNotificationRoutingStore(db);
  let now = 100_000;
  const deliver = vi.fn(async (_job: NotificationJob) => undefined);
  const authorize = vi.fn(async () => true);
  const service = new NotificationRoutingService({ store, deliver, authorize, now: () => now, onError: () => undefined });
  const input = { accountId: 'account', principalId: 'feishu:tenant:operator', conversationId: 'conversation',
    taskId: null, requestId: null, source: 'explicit_follow' as const,
    destination: { platform: 'feishu' as const, tenantKey: 'tenant', senderId: 'operator', chatId: 'chat', chatType: 'dm' as const } };
  const fact: NotificationFact = { accountId: 'account', conversationId: 'conversation', subjectId: 'turn',
    requestId: 'request', taskId: 'task', version: 'one', category: 'result', payload: { answer: 'done', deliveryStatus: 'ready' } };
  return { db, store, service, input, fact, deliver, authorize, advance: (ms: number) => { now += ms; } };
}

describe('durable notification routes', () => {
  it('bounds the ready pool and resumes disk-spooled result intents without losing source facts', async () => {
    const { service, store, input, fact, db } = fixture();
    await service.follow(input);
    for (let n = 0; n < 1030; n++) service.capture({ ...fact, subjectId: `result_${n}` });
    expect(db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE state = 'pending'").get()).toEqual({ n: 1024 });
    expect(db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE state = 'deferred'").get()).toEqual({ n: 6 });
    const first = store.claim(100_000, 'before-restart')!;
    store.settle(first, 'delivered', 100_001);
    const restored = new SqliteNotificationRoutingStore(db);
    expect(restored.claim(100_002, 'after-restart')).not.toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE state = 'deferred'").get()).toEqual({ n: 5 });
    expect(db.prepare('SELECT count(*) AS n FROM notification_outbox').get()).toEqual({ n: 1030 });
  });

  it('rotates long initial scans so a later follow is not starved', async () => {
    const { store, input, fact } = fixture();
    const first = store.upsert({ ...input, id: 'first' });
    store.upsert({ ...input, id: 'second', conversationId: 'other' });
    expect(store.nextSeed()?.route.id).toBe('first');
    store.commitSeed(first, null, { facts: [fact], nextCursor: 'more' }, 100_000);
    expect(store.nextSeed()?.route.id).toBe('second');
  });
  it('revokes a denied destination instead of retrying a policy failure forever', async () => {
    const { service, input, fact, deliver, db } = fixture();
    await service.follow(input);
    deliver.mockRejectedValue(new NotificationDestinationRevoked('destination denied'));
    service.capture(fact); await service.drain(); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT state FROM notification_outbox').get()).toEqual({ state: 'revoked' });
    expect(service.list(input.accountId, input.principalId)).toEqual([]);
  });

  it('keeps healthy destinations moving while one physical send remains outstanding', async () => {
    const { service, input, fact, deliver } = fixture();
    await service.follow(input);
    await service.follow({ ...input, destination: { ...input.destination, chatId: 'healthy' } });
    let finish!: () => void;
    deliver.mockImplementation(async job => {
      if (job.route.destination.chatId === 'chat') await new Promise<void>(resolve => { finish = resolve; });
    });
    service.capture(fact); await service.drain();
    expect(deliver.mock.calls.filter(([job]) => job.route.destination.chatId === 'healthy')).toHaveLength(1);
    service.capture({ ...fact, version: 'second' }); await service.drain();
    expect(deliver.mock.calls.filter(([job]) => job.route.destination.chatId === 'healthy')).toHaveLength(2);
    expect(deliver.mock.calls.filter(([job]) => job.route.destination.chatId === 'chat')).toHaveLength(1);
    finish(); await service.stop();
  });
  it('collects old terminal receipts on active follows while retaining undelivered results', async () => {
    const { service, input, fact, db, advance, store } = fixture();
    await service.follow(input);
    service.capture(fact); await service.drain();
    service.capture({ ...fact, subjectId: 'undelivered' });
    advance(8 * 24 * 60 * 60 * 1000);
    store.claim(100_000 + 8 * 24 * 60 * 60 * 1000, 'worker');
    expect(db.prepare('SELECT subject_id, state FROM notification_outbox').all()).toEqual([
      { subject_id: 'undelivered', state: 'sending' },
    ]);
    expect(store.list(input.accountId, input.principalId)).toHaveLength(1);
  });
  it('resumes paged initial follow after restart and suppresses approvals that resolved before delivery', async () => {
    const { store, input, fact, deliver, authorize, db } = fixture();
    const current = vi.fn((_route, cursor: string | null) => ({ facts: [{ ...fact, subjectId: cursor ?? 'first' }],
      nextCursor: cursor === null ? 'second' : null }));
    const service = () => new NotificationRoutingService({ store, current, deliver, authorize,
      valid: job => job.fact.category !== 'approval', now: () => 100_000, onError: () => undefined });
    const route = await service().follow(input);
    expect(store.nextSeed()?.cursor).toBe('second');
    service().capture({ ...fact, category: 'approval', subjectId: 'resolved' });
    await service().drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.nextSeed()).toBeNull();
    expect(db.prepare("SELECT state FROM notification_outbox WHERE subject_id = 'resolved'").get()).toEqual({ state: 'superseded' });
    expect(store.list(input.accountId, input.principalId)[0]?.id).toBe(route.id);
  });

  it('continues approval scans beyond the first page after restart without losing earlier inserts', async () => {
    const { service, input, fact, store, deliver } = fixture();
    await service.follow(input);
    store.schedulePermissions('task');
    const first = vi.fn(() => ({ facts: [{ ...fact, category: 'approval' as const, subjectId: 'first' }], nextId: 'cursor' }));
    store.scanPermissions(first, 100_000);
    expect(first).toHaveBeenCalledWith('task', '');
    store.schedulePermissions('task');
    const next = vi.fn(() => ({ facts: [{ ...fact, category: 'approval' as const, subjectId: 'second' }], nextId: null }));
    store.scanPermissions(next, 100_000); expect(next).toHaveBeenLastCalledWith('task', 'cursor');
    store.scanPermissions(next, 100_000); expect(next).toHaveBeenLastCalledWith('task', '');
    await service.drain(); expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('records one delivery per route and fact, independent of client focus and another destination receipt', async () => {
    const { service, input, fact, deliver } = fixture();
    await service.follow(input);
    await service.follow({ ...input, destination: { ...input.destination, chatId: 'another-chat' } });
    service.capture(fact); service.capture(fact);
    service.capture({ ...fact, accountId: 'foreign' });
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    service.capture(fact); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('keeps notifications on platform failure and restores claimed work after a process dies', async () => {
    const { service, store, input, fact, deliver, advance } = fixture();
    await service.follow(input); service.capture(fact);
    expect(store.claim(100_000, 'dead-process')).not.toBeNull();
    await service.drain(); expect(deliver).not.toHaveBeenCalled();
    advance(120_001);
    deliver.mockRejectedValueOnce(new Error('network unavailable'));
    await service.drain(); expect(deliver).toHaveBeenCalledTimes(1);
    advance(60_000); await service.drain(); expect(deliver).toHaveBeenCalledTimes(2);
    await service.drain(); expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('fences revoked/re-enabled routes and rechecks authority before an external delivery', async () => {
    const { service, input, fact, store, deliver, authorize } = fixture();
    const route = await service.follow(input); service.capture(fact);
    const stale = store.claim(100_000, 'stale')!;
    expect(service.unfollow('account', 'other', route.id)).toBe(false);
    expect(service.unfollow('account', input.principalId, route.id)).toBe(true);
    const replacement = await service.follow(input); expect(replacement.revision).toBe(3);
    service.capture(fact);
    store.settle(stale, 'delivered', 100_001);
    authorize.mockResolvedValue(false);
    await service.drain(); expect(deliver).not.toHaveBeenCalled();
    expect(service.list('account', input.principalId)).toEqual([]);
  });

  it('coalesces unsent progress per subject without delaying an approval or final result', async () => {
    const { service, input, fact, deliver, advance } = fixture();
    await service.follow(input);
    for (let n = 0; n < 100; n++) service.capture({ ...fact, category: 'progress', version: String(n) });
    service.capture({ ...fact, category: 'approval', subjectId: 'permission' });
    service.capture(fact); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    advance(2_001); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({ fact: { category: 'progress', version: '99' } });
  });

  it('commits notification intents with the source projection or rolls both back', async () => {
    const { db, store, service, input, deliver } = fixture();
    await service.follow(input);
    const model = new SqliteConversationReadModel(db, Date.now, (account, turn) => {
      const fact = notificationFromTurn(account, turn); if (fact) store.capture(fact, 100_000);
    });
    const projector = new ConversationReadProjector(model);
    const event = { protocolVersion: 2 as const, accountId: 'account', conversationId: 'conversation', turnId: 'turn',
      requestId: 'request', sequence: 1, eventId: 'event', kind: 'final_answer' as const, payload: { lines: ['answer'] }, occurredAt: '' };
    db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON conversation_read_heads BEGIN SELECT RAISE(ABORT, 'crash'); END");
    expect(() => projector.apply('account', 'conversation', [event], 1)).toThrow('crash');
    expect(model.head('account', 'conversation')).toBeNull();
    await service.drain(); expect(deliver).not.toHaveBeenCalled();
    db.exec('DROP TRIGGER fail_commit');
    projector.apply('account', 'conversation', [event], 1);
    await service.drain(); expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers progress on schedule even while newer progress keeps arriving', async () => {
    const { service, input, fact, deliver, advance } = fixture();
    await service.follow(input);
    for (let n = 0; n < 5; n++) {
      service.capture({ ...fact, category: 'progress', version: String(n) });
      advance(500);
    }
    await service.drain();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ fact: { version: '4' } });
  });

  it('renews an in-flight delivery lease and fences renewal after route revocation', async () => {
    const { service, store, input, fact } = fixture();
    const route = await service.follow(input); service.capture(fact);
    const job = store.claim(100_000, 'worker')!;
    expect(store.renew(job, 200_000)).toBe(true);
    expect(store.claim(230_000, 'other')).toBeNull();
    service.unfollow(input.accountId, input.principalId, route.id);
    expect(store.renew(job, 230_000)).toBe(false);
  });

  it('seeds a new follow from current facts without replaying the journal', async () => {
    const { store, input, fact, deliver, authorize } = fixture();
    const current = vi.fn(() => ({ facts: [fact], nextCursor: null }));
    const service = new NotificationRoutingService({ store, current, deliver, authorize, now: () => 100_000, onError: () => undefined });
    await service.follow(input);
    await service.drain();
    expect(current).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    await service.follow(input); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers late corrected results to the default reply destination within its retention window', async () => {
    const { service, input, fact, deliver, advance } = fixture();
    await service.follow({ ...input, source: 'default_reply', requestId: fact.requestId });
    service.capture(fact); await service.drain();
    advance(10_000);
    service.capture({ ...fact, version: 'corrected', payload: { answer: 'corrected answer', deliveryStatus: 'ready' } });
    await service.drain(); expect(deliver).toHaveBeenCalledTimes(2);
    advance(24 * 60 * 60 * 1000 + 1);
    service.capture({ ...fact, version: 'expired' }); await service.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
