import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationMetadata } from '../../src/session/conversation-store.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteWorkspaceDirectoryProjectionRepo } from '../../src/storage/workspace-directory-projection-repo.js';
import { WorkspaceDirectoryProjector } from '../../src/workspace/workspace-directory-projector.js';
import type { WorkspaceConversationSummary } from '../../src/workspace/workspace-conversation-projector.js';

const [root, action, operation, phase] = process.argv.slice(2);
if (!root || !action) throw new Error('fixture root and action required');
const accountId = 'local-default';
const otherAccountId = 'other-account';
const workspaceId = 'workspace_one';
const sourcePath = join(root, 'metadata.json');
const db = new Database(join(root, 'directory.db'), { fileMustExist: action !== 'seed' });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
const repo = new SqliteWorkspaceDirectoryProjectionRepo(db, accountId);
const otherRepo = new SqliteWorkspaceDirectoryProjectionRepo(db, otherAccountId);
const activityReads: string[][] = [];

function metadata(id: string, owner = accountId): ConversationMetadata {
  return {
    id, accountId: owner, plannerSessionId: `planner_${id}`, title: `Title ${id}`,
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    archived: false,
    workspaceBinding: { workspaceId, boundAt: '2026-09-26T00:00:00.000Z', boundByPrincipal: 'fixture' },
  };
}

function makeProjector(): WorkspaceDirectoryProjector {
  return new WorkspaceDirectoryProjector({
    accountId, projection: repo, batchSize: 2,
    readMetadata: async () => JSON.parse(await readFile(sourcePath, 'utf8')) as ConversationMetadata[],
    getActivities: inputs => {
      activityReads.push(inputs.map(item => item.conversationId));
      return new Map(inputs.map(item => [item.conversationId, {
        state: 'blocked' as const, taskId: `task_${item.conversationId}`, updatedAt: item.updatedAt,
      }]));
    },
    yieldBatch: async () => {
      if (action !== 'interrupt') return;
      if (operation === 'batch' && phase === 'after' && repo.state()?.checkpoint === 'conv_003') pause();
      if (operation === 'live' && repo.state()?.checkpoint === 'conv_001') {
        projector.observeMetadata({ ...metadata('conv_004'), title: 'Live title, unchanged timestamp' });
        projector.observeMetadata({ ...metadata('conv_005'), workspaceBinding: null });
        projector.observeMetadata(metadata('conv_live'));
        pause();
      }
    },
  });
}

const projector = makeProjector();

function emit(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

function pause(): never {
  emit({ paused: true, operation, phase, inTransaction: db.inTransaction });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('fixture pause unexpectedly resumed');
}

function candidates(owner: string): string[] {
  return (db.prepare(`SELECT conversation_id FROM workspace_directory_rebuild_candidates
    WHERE account_id = ? ORDER BY conversation_id`).all(owner) as { conversation_id: string }[])
    .map(row => row.conversation_id);
}

function armInterruption(): void {
  if (operation === 'batch') {
    if (phase === 'during') {
      db.function('fixture_pause', pause);
      db.exec(`CREATE TEMP TRIGGER fixture_pause_batch AFTER INSERT ON workspace_directory_projection
        WHEN NEW.account_id = '${accountId}' AND NEW.conversation_id = 'conv_002'
        BEGIN SELECT fixture_pause(); END`);
    } else if (phase === 'before') {
      const writeBatch = repo.writeBatch.bind(repo);
      repo.writeBatch = (...args) => {
        if (args[1] === 'conv_003') pause();
        writeBatch(...args);
      };
    } else if (phase !== 'after') throw new Error('invalid batch phase');
  } else if (operation === 'completion' || operation === 'sweep') {
    if (operation === 'completion' && phase === 'during') {
      db.function('fixture_pause', pause);
      db.exec(`CREATE TEMP TRIGGER fixture_pause_completion AFTER UPDATE ON workspace_directory_rebuilds
        WHEN NEW.account_id = '${accountId}' AND OLD.status = 'building' AND NEW.status = 'ready'
        BEGIN SELECT fixture_pause(); END`);
    } else {
      if (!['before', 'after'].includes(phase ?? '')) throw new Error('invalid finish phase');
      const finishRebuild = repo.finishRebuild.bind(repo);
      repo.finishRebuild = token => {
        if (operation === 'completion' && phase === 'before' && candidates(accountId).length <= 100) pause();
        const complete = finishRebuild(token);
        if ((operation === 'completion' && complete) || (operation === 'sweep' && !complete)) pause();
        return complete;
      };
    }
  } else if (operation !== 'live' || phase !== 'after') {
    throw new Error('invalid interruption');
  }
}

function rows(owner: string): WorkspaceConversationSummary[] {
  return (db.prepare(`SELECT summary_json FROM workspace_directory_projection
    WHERE account_id = ? ORDER BY conversation_id`).all(owner) as { summary_json: string }[])
    .map(row => JSON.parse(row.summary_json) as WorkspaceConversationSummary);
}

async function diskState() {
  let pageError: string | null = null;
  const pageIds: string[] = [];
  const pageSizes: number[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = repo.page(workspaceId, { limit: 2, cursor });
      pageIds.push(...page.items.map(item => item.conversationId));
      pageSizes.push(page.items.length);
      cursor = page.nextCursor ?? undefined;
      if (pageSizes.length > 200) throw new Error('fixture pagination did not terminate');
    } while (cursor);
  } catch (error) {
    pageError = error instanceof Error ? error.message : String(error);
  }
  const checkpoint = db.prepare('SELECT checkpoint FROM workspace_directory_rebuilds WHERE account_id = ?')
    .get(accountId) as { checkpoint: string } | undefined;
  return {
    state: repo.state(),
    progress: checkpoint ? JSON.parse(checkpoint.checkpoint) : null,
    rows: rows(accountId), candidates: candidates(accountId),
    observations: db.prepare(`SELECT conversation_id AS conversationId, rebuild_id AS rebuildId, removed
      FROM workspace_directory_observations WHERE account_id = ? ORDER BY conversation_id`).all(accountId),
    other: {
      state: otherRepo.state(), rows: rows(otherAccountId), candidates: candidates(otherAccountId),
      revisions: db.prepare(`SELECT workspace_id, revision FROM workspace_directory_revisions
        WHERE account_id = ? ORDER BY workspace_id`).all(otherAccountId),
    },
    pageIds, pageSizes, pageError,
    sourceSha256: createHash('sha256').update(await readFile(sourcePath)).digest('hex'),
    integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'),
  };
}

async function main(): Promise<void> {
  if (action === 'seed') {
    runMigrations(db);
    const source = [
      { ...metadata('conv_unbound'), workspaceBinding: null },
      metadata('conv_foreign', otherAccountId),
      ...Array.from({ length: 7 }, (_, i) => metadata(`conv_00${6 - i}`)),
    ];
    await writeFile(sourcePath, JSON.stringify(source), { flag: 'wx', mode: 0o600 });
    // More than two sweep batches exercise durable deletion reconciliation too.
    for (let i = 0; i < 205; i++) {
      projector.observeMetadata(metadata(`conv_obsolete_${String(i).padStart(3, '0')}`));
    }
    projector.observeMetadata(metadata('conv_unbound'));
    projector.observeMetadata(metadata('conv_foreign'));
    await new WorkspaceDirectoryProjector({
      accountId: otherAccountId, projection: otherRepo,
      readMetadata: async () => [metadata('conv_000', otherAccountId), metadata('conv_foreign', otherAccountId)],
      getActivities: () => new Map(),
      yieldBatch: async () => undefined,
    }).rebuild();
    emit({ disk: await diskState() });
  } else if (action === 'interrupt') {
    armInterruption();
    await projector.rebuild();
    throw new Error('interruption hook was not reached');
  } else if (action === 'recover') {
    const before = await diskState();
    await projector.rebuild();
    emit({ before, activityReads, disk: await diskState() });
  } else if (action === 'read') {
    emit({ disk: await diskState() });
  } else {
    throw new Error(`unknown fixture action: ${action}`);
  }
}

main().then(() => db.close()).catch(error => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
