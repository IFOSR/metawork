import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteWorkspaceDirectoryProjectionRepo } from '../../src/storage/workspace-directory-projection-repo.js';
import { WorkspaceDirectoryProjector } from '../../src/workspace/workspace-directory-projector.js';
import type { ConversationMetadata } from '../../src/session/conversation-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function metadata(id: string): ConversationMetadata {
  return {
    id, plannerSessionId: id, accountId: 'local-default', title: id,
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    archived: false,
    workspaceBinding: { workspaceId: 'workspace_one', boundAt: 'now', boundByPrincipal: 'local' },
  };
}

function reconciliationFixture(initial: readonly ConversationMetadata[]) {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  const repo = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
  let source = initial;
  const make = (options: {
    readMetadata?: () => Promise<readonly ConversationMetadata[]>;
    yieldBatch?: () => Promise<void>;
    projection?: SqliteWorkspaceDirectoryProjectionRepo;
  } = {}) => new WorkspaceDirectoryProjector({
    accountId: 'local-default',
    projection: options.projection ?? repo,
    readMetadata: options.readMetadata ?? (async () => source),
    getActivities: inputs => new Map(inputs.map(item => [
      item.conversationId, { state: 'idle' as const, taskId: null, updatedAt: item.updatedAt },
    ])),
    batchSize: 1,
    yieldBatch: options.yieldBatch ?? (async () => undefined),
  });
  return { db, repo, make, setSource: (next: readonly ConversationMetadata[]) => { source = next; } };
}

describe('Workspace directory rebuild', () => {
  it('reconciles source deletions and unbound rows without touching another account', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b'), metadata('conv_c')]);
    const projector = fixture.make();
    await projector.rebuild();
    const other = new SqliteWorkspaceDirectoryProjectionRepo(fixture.db, 'other');
    other.upsert(fixture.repo.find('conv_b')!);
    fixture.setSource([metadata('conv_a'), { ...metadata('conv_c'), workspaceBinding: null }]);

    await projector.rebuild();

    expect(fixture.repo.page('workspace_one', {}).items.map(item => item.conversationId)).toEqual(['conv_a']);
    expect(fixture.repo.find('conv_b')).toBeNull();
    expect(fixture.repo.find('conv_c')).toBeNull();
    expect(other.find('conv_b')).not.toBeNull();
  });

  it('removes an observed unbound Conversation and invalidates its directory cursor', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    const projector = fixture.make();
    await projector.rebuild();
    const cursor = fixture.repo.page('workspace_one', { limit: 1 }).nextCursor!;

    projector.observeMetadata({ ...metadata('conv_b'), workspaceBinding: null });

    expect(fixture.repo.find('conv_b')).toBeNull();
    expect(() => fixture.repo.page('workspace_one', { cursor })).toThrow('stale_directory_cursor');
  });

  it('protects changes committed while the asynchronous source read is in flight', async () => {
    const stale = [metadata('conv_a'), metadata('conv_b')];
    const fixture = reconciliationFixture(stale);
    await fixture.make().rebuild();
    let resolveSource!: (source: readonly ConversationMetadata[]) => void;
    const projector = fixture.make({
      readMetadata: () => new Promise(resolve => { resolveSource = resolve; }),
    });
    const rebuilding = projector.rebuild();
    projector.observeMetadata({ ...metadata('conv_a'), title: 'Fresh title at the same timestamp' });
    projector.observeMetadata({ ...metadata('conv_b'), workspaceBinding: null });
    projector.observeMetadata(metadata('conv_new'));
    resolveSource(stale);
    await rebuilding;

    expect(fixture.repo.find('conv_a')?.title).toBe('Fresh title at the same timestamp');
    expect(fixture.repo.find('conv_b')).toBeNull();
    expect(fixture.repo.find('conv_new')).not.toBeNull();
  });

  it('does not overwrite a concurrent archive or authorized rebind from a stale later batch', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    await fixture.make().rebuild();
    const changed: ConversationMetadata = {
      ...metadata('conv_b'), archived: true,
      workspaceBinding: { workspaceId: 'workspace_two', boundAt: 'now', boundByPrincipal: 'local' },
    };
    let injected = false;
    const projector = fixture.make({
      yieldBatch: async () => {
        if (!injected) projector.observeMetadata(changed);
        injected = true;
      },
    });

    await projector.rebuild();

    expect(fixture.repo.find('conv_b')).toMatchObject({ archived: true, workspaceId: 'workspace_two' });
    expect(fixture.repo.page('workspace_one', {}).items.map(item => item.conversationId)).toEqual(['conv_a']);
  });

  it('preserves an unchanged live observation missing from the rebuild snapshot', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    await fixture.make().rebuild();
    fixture.setSource([metadata('conv_a')]);
    const projector = fixture.make({
      yieldBatch: async () => { projector.observeMetadata(metadata('conv_b')); },
    });

    await projector.rebuild();

    expect(fixture.repo.find('conv_b')).not.toBeNull();
  });

  it('preserves a live activity observation without importing a stale later row', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    await fixture.make().rebuild();
    let injected = false;
    const projector = fixture.make({
      yieldBatch: async () => {
        if (!injected) projector.observeActivity('conv_b', {
          state: 'planning', taskId: null, updatedAt: '2026-09-26T01:00:00.000Z',
        });
        injected = true;
      },
    });

    await projector.rebuild();

    expect(fixture.repo.find('conv_b')?.activity.state).toBe('planning');
  });

  it('refreshes pre-restart activity even when the canonical fact timestamp moves backwards', async () => {
    const fixture = reconciliationFixture([metadata('conv_a')]);
    const projector = fixture.make();
    await projector.rebuild();
    projector.observeActivity('conv_a', {
      state: 'planning', taskId: null, updatedAt: '2026-09-26T01:00:00.000Z',
    });

    await fixture.make().rebuild();

    expect(fixture.repo.find('conv_a')?.activity).toEqual({
      state: 'idle', taskId: null, updatedAt: metadata('conv_a').updatedAt,
    });
  });

  it('keeps explicit deletion durable across later stale rebuilds until a live bind restores it', async () => {
    const fixture = reconciliationFixture([metadata('conv_a')]);
    const projector = fixture.make();
    await projector.rebuild();
    projector.observeDeletion('conv_a');
    expect(fixture.repo.find('conv_a')).toBeNull();

    await fixture.make().rebuild();

    expect(fixture.repo.find('conv_a')).toBeNull();
    projector.observeMetadata(metadata('conv_a'));
    expect(fixture.repo.find('conv_a')).not.toBeNull();
  });

  it('does not resurrect an unbound row after interruption and repository reopening', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    const interrupted = fixture.make({
      yieldBatch: async () => {
        interrupted.observeMetadata({ ...metadata('conv_b'), workspaceBinding: null });
        throw new Error('interrupted');
      },
    });
    await expect(interrupted.rebuild()).rejects.toThrow('interrupted');
    const reopened = new SqliteWorkspaceDirectoryProjectionRepo(fixture.db, 'local-default');

    await fixture.make({ projection: reopened }).rebuild();

    expect(reopened.find('conv_a')).not.toBeNull();
    expect(reopened.find('conv_b')).toBeNull();
    expect(reopened.state()?.status).toBe('ready');
  });

  it('reconciles already imported rows when the source changes before recovery', async () => {
    const fixture = reconciliationFixture([metadata('conv_a'), metadata('conv_b')]);
    await expect(fixture.make({
      yieldBatch: async () => { throw new Error('interrupted'); },
    }).rebuild()).rejects.toThrow('interrupted');
    expect(fixture.repo.find('conv_a')).not.toBeNull();
    fixture.setSource([metadata('conv_b')]);

    await fixture.make().rebuild();

    expect(fixture.repo.find('conv_a')).toBeNull();
    expect(fixture.repo.page('workspace_one', {}).items.map(item => item.conversationId)).toEqual(['conv_b']);
  });

  it('does not reconcile away existing rows when the source cannot be read', async () => {
    const fixture = reconciliationFixture([metadata('conv_a')]);
    await fixture.make().rebuild();

    await expect(fixture.make({
      readMetadata: async () => { throw new Error('source unavailable'); },
    }).rebuild()).rejects.toThrow('source unavailable');

    expect(fixture.repo.find('conv_a')).not.toBeNull();
    expect(() => fixture.repo.page('workspace_one', {})).toThrow('directory_rebuilding');
    await fixture.make().rebuild();
    expect(fixture.repo.page('workspace_one', {}).items).toHaveLength(1);
  });

  it('does not overwrite newer Planner activity while an earlier row publication is awaiting', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    runMigrations(db);
    const repo = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    let injecting = false;
    const published: string[] = [];
    const projector = new WorkspaceDirectoryProjector({
      accountId: 'local-default', projection: repo,
      readMetadata: async () => [metadata('conv_a'), metadata('conv_b')],
      getActivities: items => new Map(items.map(item => [
        item.conversationId, { state: 'planning' as const, taskId: null, updatedAt: item.updatedAt },
      ])),
      onActivity: async (id, activity) => {
        published.push(`${id}:${activity.state}`);
        if (id === 'conv_a' && injecting) {
          projector.observeActivity('conv_b', { state: 'idle', taskId: null, updatedAt: 'now' });
        }
      },
    });
    await projector.rebuild();
    for (const id of ['conv_a', 'conv_b']) {
      db.prepare(`INSERT INTO workspace_directory_dirty VALUES ('local-default', ?, 1)`).run(id);
    }
    injecting = true;
    await projector.drainChanges();
    expect(repo.find('conv_b')?.activity.state).toBe('idle');
    expect(published).toEqual(['conv_a:planning', 'conv_b:idle']);
  });
  it('resumes committed batches after interruption without projecting unbound or other accounts', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    runMigrations(db);
    const repo = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    const source = [
      ...Array.from({ length: 5 }, (_, i) => metadata(`conv_${i}`)),
      { ...metadata('conv_unbound'), workspaceBinding: null },
      { ...metadata('conv_other'), accountId: 'other' },
    ];
    const activity = vi.fn((items: readonly { conversationId: string; updatedAt: string }[]) => (
      new Map(items.map(item => [item.conversationId, {
        state: 'blocked' as const, taskId: 'task_one', updatedAt: item.updatedAt,
      }]))
    ));
    const make = (yieldBatch: () => Promise<void>) => new WorkspaceDirectoryProjector({
      accountId: 'local-default', projection: repo,
      readMetadata: async () => source, getActivities: activity, batchSize: 2, yieldBatch,
    });
    await expect(make(async () => { throw new Error('process interrupted'); }).rebuild())
      .rejects.toThrow('process interrupted');
    expect(repo.state()).toMatchObject({ status: 'building', checkpoint: 'conv_1' });
    expect(() => repo.page('workspace_one', {})).toThrow('directory_rebuilding');
    activity.mockClear();
    await make(async () => undefined).rebuild();
    expect(activity.mock.calls.flatMap(([items]) => items.map(item => item.conversationId)))
      .toEqual(['conv_2', 'conv_3', 'conv_4']);
    expect(repo.page('workspace_one', {}).items).toHaveLength(5);
    expect(repo.find('conv_other')).toBeNull();
    expect(repo.find('conv_unbound')).toBeNull();
  });

  it('keeps activity when only metadata changes and refreshes facts older than the observation', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    runMigrations(db);
    const repo = new SqliteWorkspaceDirectoryProjectionRepo(db, 'local-default');
    const projector = new WorkspaceDirectoryProjector({
      accountId: 'local-default', projection: repo, readMetadata: async () => [],
      getActivities: () => new Map(),
    });
    await projector.rebuild();
    projector.observeMetadata(metadata('conv_one'));
    projector.observeActivity('conv_one', { state: 'executing', taskId: 'task_one', updatedAt: '2026-09-25T00:00:00Z' });
    projector.observeMetadata({ ...metadata('conv_one'), title: 'Renamed', updatedAt: '2026-09-26T01:00:00Z' });
    expect(repo.find('conv_one')).toMatchObject({ title: 'Renamed', activity: { state: 'executing' } });
    projector.observeActivity('conv_one', { state: 'idle', taskId: null, updatedAt: '2026-09-25T00:00:00Z' });
    expect(repo.find('conv_one')?.activity.state).toBe('idle');
  });
});
