import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSessionCatalog } from '../../src/management/web-session-catalog.js';
import {
  MAX_WEB_SESSION_EVENTS_PER_TURN,
  MAX_WEB_SESSION_TURNS,
  type ConversationTurn,
} from '../../src/management/web-session-types.js';
import { FileWebSessionStore } from '../../src/storage/file-web-session-store.js';

const temporaryRoots: string[] = [];

async function makeCatalog(
  timestamps: string[] = ['2026-08-17T08:00:00.000Z'],
): Promise<WebSessionCatalog> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-web-session-catalog-'));
  temporaryRoots.push(root);
  let id = 0;
  let time = 0;
  const catalog = new WebSessionCatalog(
    new FileWebSessionStore(join(root, 'web-sessions')),
    {
      createId: () => `session_${++id}`,
      now: () => timestamps[Math.min(time++, timestamps.length - 1)]!,
    },
  );
  await catalog.initialize();
  return catalog;
}

function makeTurn(
  sessionId: string,
  index: number,
  userInput = `request ${index}`,
  traceEventCount = 1,
): ConversationTurn {
  return {
    id: `turn_${index}`,
    sessionId,
    userInput,
    status: 'completed',
    finalAnswer: `answer ${index}`,
    taskId: `task_${index}`,
    startedAt: '2026-08-17T08:00:00.000Z',
    completedAt: '2026-08-17T08:00:05.000Z',
    traceEvents: Array.from(
      { length: traceEventCount },
      (_, eventIndex) => ({
        id: `event_${index}_${eventIndex}`,
        sequence: eventIndex + 1,
        occurredAt: '2026-08-17T08:00:01.000Z',
        phase: 'planning' as const,
        actor: 'planner' as const,
        kind: 'planner_progress',
        status: 'completed' as const,
        title: 'Planner progress',
        summary: `safe summary ${eventIndex}`,
        details: {},
      }),
    ),
    executionTimeline: null,
    artifactRefs: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('WebSessionCatalog', () => {
  it('creates an empty session with a normalized bounded title', async () => {
    const catalog = await makeCatalog();

    const record = await catalog.create({
      title: `  ${'Detailed   AI news '.repeat(10)}  `,
      active: true,
    });

    expect(record.session.id).toBe('session_1');
    expect(record.session.title.length).toBeLessThanOrEqual(80);
    expect(record.session.title).not.toMatch(/\s{2,}/u);
    expect(record.session.active).toBe(true);
    expect(record.turns).toEqual([]);
    expect(await catalog.read('session_1')).toEqual(record);
  });

  it('sorts sessions by latest update and persists after catalog recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-web-session-reload-'));
    temporaryRoots.push(root);
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    let id = 0;
    const times = [
      '2026-08-17T08:00:00.000Z',
      '2026-08-17T08:00:01.000Z',
      '2026-08-17T08:00:02.000Z',
    ];
    let time = 0;
    const catalog = new WebSessionCatalog(store, {
      createId: () => `session_${++id}`,
      now: () => times[time++]!,
    });
    await catalog.initialize();
    await catalog.create({ title: 'First' });
    await catalog.create({ title: 'Second' });

    const reloaded = new WebSessionCatalog(
      new FileWebSessionStore(join(root, 'web-sessions')),
    );
    await reloaded.initialize();

    expect((await reloaded.list()).map(session => session.title)).toEqual([
      'Second',
      'First',
    ]);
  });

  it('searches normalized titles and persisted turn text', async () => {
    const catalog = await makeCatalog([
      '2026-08-17T08:00:00.000Z',
      '2026-08-17T08:00:01.000Z',
      '2026-08-17T08:00:02.000Z',
    ]);
    const first = await catalog.create({ title: 'Market briefing' });
    const second = await catalog.create({ title: 'Research notes' });
    await catalog.appendTurn(
      second.session.id,
      makeTurn(second.session.id, 1, 'Summarize last week AI news'),
    );

    expect((await catalog.search('market')).map(session => session.id)).toEqual([
      first.session.id,
    ]);
    expect((await catalog.search('AI NEWS')).map(session => session.id)).toEqual([
      second.session.id,
    ]);
  });

  it('bounds retained turns and each turn trace while deriving an initial title', async () => {
    const catalog = await makeCatalog(
      Array.from(
        { length: MAX_WEB_SESSION_TURNS + 4 },
        (_, index) => new Date(Date.UTC(2026, 7, 17, 8, 0, index)).toISOString(),
      ),
    );
    const record = await catalog.create();

    for (let index = 1; index <= MAX_WEB_SESSION_TURNS + 2; index += 1) {
      await catalog.appendTurn(
        record.session.id,
        makeTurn(
          record.session.id,
          index,
          index === 1 ? '  Explain   the Planner execution flow  ' : `request ${index}`,
          index === 3 ? MAX_WEB_SESSION_EVENTS_PER_TURN + 2 : 1,
        ),
      );
    }

    const updated = await catalog.read(record.session.id);
    expect(updated?.session.title).toBe('Explain the Planner execution flow');
    expect(updated?.turns).toHaveLength(MAX_WEB_SESSION_TURNS);
    expect(updated?.turns[0]?.id).toBe('turn_3');
    expect(updated?.turns[0]?.traceEvents).toHaveLength(
      MAX_WEB_SESSION_EVENTS_PER_TURN,
    );
    expect(updated?.turns[0]?.traceEvents[0]?.sequence).toBe(3);
  });

  it('archives sessions without deleting their projections', async () => {
    const catalog = await makeCatalog([
      '2026-08-17T08:00:00.000Z',
      '2026-08-17T08:00:01.000Z',
    ]);
    const record = await catalog.create({ title: 'Archive me', active: true });

    const archived = await catalog.archive(record.session.id);

    expect(archived?.session).toMatchObject({ active: false, archived: true });
    expect(await catalog.read(record.session.id)).toEqual(archived);
  });
});
