import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWebSessionStore,
  type WebSessionCatalogFile,
} from '../../src/storage/file-web-session-store.js';
import {
  WEB_SESSION_FORMAT_VERSION,
  type WebSessionRecord,
} from '../../src/management/web-session-types.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-web-session-store-'));
  temporaryRoots.push(root);
  return root;
}

function makeRecord(id = 'session_1'): WebSessionRecord {
  return {
    version: WEB_SESSION_FORMAT_VERSION,
    session: {
      id,
      title: 'AI news',
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:05.000Z',
      active: true,
      archived: false,
    },
    turns: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('FileWebSessionStore', () => {
  it('initializes below the configured AnyFusion data directory', async () => {
    const installRoot = await temporaryRoot();
    const previous = process.env.ANYFUSION_INSTALL_ROOT;
    process.env.ANYFUSION_INSTALL_ROOT = installRoot;
    try {
      const store = new FileWebSessionStore();
      await store.initialize();

      expect(store.rootDir).toBe(join(installRoot, 'data', 'web-sessions'));
      expect(JSON.parse(await readFile(store.catalogPath, 'utf8'))).toEqual({
        version: WEB_SESSION_FORMAT_VERSION,
        sessions: [],
      });
      expect(await readdir(store.sessionsDir)).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.ANYFUSION_INSTALL_ROOT;
      } else {
        process.env.ANYFUSION_INSTALL_ROOT = previous;
      }
    }
  });

  it('atomically writes catalog and session records that survive reload', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();
    const record = makeRecord();
    const catalog: WebSessionCatalogFile = {
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [record.session],
    };

    await store.writeSession(record);
    await store.writeCatalog(catalog);

    const reloaded = new FileWebSessionStore(join(root, 'web-sessions'));
    await reloaded.initialize();
    expect(await reloaded.readSession('session_1')).toEqual(record);
    expect(await reloaded.readCatalog()).toEqual(catalog);
    expect((await readdir(reloaded.rootDir)).some(name => name.includes('.tmp-'))).toBe(false);
    expect((await readdir(reloaded.sessionsDir)).some(name => name.includes('.tmp-'))).toBe(false);
  });

  it('normalizes historical records that predate the artifacts projection field', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();
    const record = makeRecord();
    const catalog: WebSessionCatalogFile = {
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [record.session],
    };
    await store.writeSession(record);
    await store.writeCatalog(catalog);
    // 模拟 schema 升级前的历史落盘记录：turn 没有 artifacts 字段。
    const sessionPath = join(store.sessionsDir, 'session_1.json');
    const legacy = JSON.parse(await readFile(sessionPath, 'utf8')) as {
      turns: Array<Record<string, unknown>>;
    };
    legacy.turns.push({
      id: 'turn_legacy',
      sessionId: record.session.id,
      userInput: '历史输入',
      status: 'completed',
      finalAnswer: '完成',
      taskId: null,
      startedAt: '2026-08-17T08:00:00.000Z',
      completedAt: '2026-08-17T08:00:05.000Z',
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: ['report.md'],
    });
    await writeFile(sessionPath, JSON.stringify(legacy), 'utf8');

    const reloaded = await store.readSession('session_1');

    expect(reloaded?.turns.at(-1)).toMatchObject({ artifactRefs: ['report.md'] });
    expect(Array.isArray(reloaded?.turns.at(-1)?.artifacts)).toBe(true);
    expect(reloaded?.turns.at(-1)?.artifacts).toEqual([]);
  });

  it('quarantines a malformed record without replacing the catalog', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();
    const record = makeRecord();
    const catalog: WebSessionCatalogFile = {
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [record.session],
    };
    await store.writeSession(record);
    await store.writeCatalog(catalog);
    await writeFile(join(store.sessionsDir, 'session_1.json'), '{broken json', 'utf8');

    expect(await store.readSession('session_1')).toBeNull();
    expect(await store.readCatalog()).toEqual(catalog);
    expect(await readdir(store.quarantineDir)).toEqual([
      expect.stringMatching(/^session_1\.\d+\.invalid\.json$/u),
    ]);
  });

  it('rejects session identifiers that could escape the store directory', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();

    await expect(store.readSession('../outside')).rejects.toThrow('Invalid Web session ID');
    await expect(store.writeSession(makeRecord('../outside'))).rejects.toThrow(
      'Invalid Web session ID',
    );
  });

  it('hard-deletes a session file and its catalog entry', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();
    const record = makeRecord();
    await store.writeSession(record);
    await store.writeCatalog({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [record.session],
    });

    expect(await store.deleteSession(record.session.id)).toBe(true);
    expect(await store.readSession(record.session.id)).toBeNull();
    expect(await store.readCatalog()).toEqual({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [],
    });
    expect(await readdir(store.sessionsDir)).toEqual([]);
    expect(await readdir(store.quarantineDir)).toEqual([
      expect.stringMatching(/^session_1\.\d+\.deleted\.json$/u),
    ]);
  });

  it('reports false when deleting a missing session without touching the catalog', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();

    expect(await store.deleteSession('missing')).toBe(false);
    expect(await store.readCatalog()).toEqual({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [],
    });
  });

  it('rejects invalid ids on delete without escaping the directory', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();

    await expect(store.deleteSession('../outside')).rejects.toThrow('Invalid Web session ID');
  });

  it('deletes all sessions except the preserved one and returns the deleted count', async () => {
    const root = await temporaryRoot();
    const store = new FileWebSessionStore(join(root, 'web-sessions'));
    await store.initialize();
    const keep = makeRecord('session_keep');
    const dropA = makeRecord('session_a');
    const dropB = makeRecord('session_b');
    await store.writeSession(keep);
    await store.writeSession(dropA);
    await store.writeSession(dropB);
    await store.writeCatalog({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: [keep.session, dropA.session, dropB.session],
    });

    expect(await store.deleteAllSessions('session_keep')).toBe(2);
    expect((await store.readCatalog()).sessions.map(session => session.id)).toEqual([
      'session_keep',
    ]);
    expect(await readdir(store.sessionsDir)).toEqual(['session_keep.json']);
  });
});
