/**
 * Regression tests for the reviewed findings.
 *
 * Each case is named after the finding id in
 * `docs/tech-debt/memory-review-remediation.md` so a future regression points
 * straight at the contract it broke.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryService } from '../../src/memory/memory-service.js';
import { MemoryFlushScheduler } from '../../src/memory/memory-flush-scheduler.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../../src/storage/memory-flush-cursor-repo.js';
import { MemoryRecallRepo } from '../../src/storage/memory-recall-repo.js';
import {
  MEMORY_MAX_MESSAGES_PER_DEPOSIT,
  MEMORY_MAX_TURNS_PER_DEPOSIT,
  SqliteMemoryTurnSource,
} from '../../src/storage/memory-turn-source.js';
import { classifyConfigurationDiff } from '../../src/configuration/configuration-diff.js';
import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import { resolveMemoryRuntimePolicy, type MemoryRuntimePolicy } from '../../src/memory/memory-runtime-policy.js';
import { resolveDataDir } from '../../src/memory/memory-runtime.js';
import {
  buildSidecarEnvironment,
  interpretEngineHealth,
} from '../../src/memory/memory-sidecar.js';
import { PlannerDataReader } from '../../src/planning/planner-mcp-server.js';
import type { MemoryPort } from '../../src/memory/memory-port.js';
import type { MemoryFlushBatch, MemoryScope } from '../../src/memory/memory-types.js';

const ACCOUNT = 'local-default';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

interface TurnSpec {
  id: string;
  sequence: number;
  status?: string;
  user?: string;
  answer?: string;
  interactionKind?: string;
  completedAt?: string;
}

function seedTurn(db: Database.Database, conversationId: string, spec: TurnSpec): void {
  const body = {
    id: spec.id,
    conversationId,
    requestId: 'req',
    revision: 1,
    firstSequence: spec.sequence,
    lastSequence: spec.sequence,
    userInput: spec.user ?? `问题 ${spec.sequence}`,
    userInputRef: null,
    answer: spec.answer ?? `回答 ${spec.sequence}`,
    answerRef: null,
    resultId: null,
    certification: null,
    completeness: null,
    resultOffset: 0,
    resultPreviewOmitted: false,
    status: spec.status ?? 'completed',
    deliveryStatus: 'ready',
    taskId: null,
    startedAt: '2026-10-22T00:00:00.000Z',
    completedAt: spec.completedAt ?? '2026-10-22T00:01:00.000Z',
    interactionKind: spec.interactionKind ?? 'ai_turn',
  };
  db.prepare(`INSERT INTO conversation_read_turns
    (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
    .run(ACCOUNT, conversationId, `epoch-${conversationId}`, spec.id, spec.sequence,
      JSON.stringify(body), 100);
}

class RecordingPort implements MemoryPort {
  deposits: Array<{ batch: MemoryFlushBatch; scope: MemoryScope }> = [];
  fail = false;
  async health() { return { ready: true, ftsAvailable: true }; }
  async deposit(batch: MemoryFlushBatch, scope: MemoryScope) {
    if (this.fail) throw new Error('engine unavailable');
    this.deposits.push({ batch, scope });
    return { accepted: batch.turns.length * 2 };
  }
  async search() { return { items: [], degraded: false }; }
  async materialize() {
    return { id: 'm', type: 'persona', content: 'c', background: null, createdAt: '', updatedAt: '' };
  }
  async listAssets() { return { items: [], total: 0 }; }
  async updateAsset() { return { memoryId: 'm', version: 'v2' }; }
  async deleteAsset() { return { deleted: true }; }
  async readPersona() { return { content: null, updatedAt: null }; }
}

function buildService(db: Database.Database, port: MemoryPort, thresholds = {}) {
  const bindings = new MemoryBindingsRepo(db);
  const cursors = new MemoryFlushCursorRepo(db);
  const service = new MemoryService({
    port,
    bindings,
    cursors,
    turns: new SqliteMemoryTurnSource(db),
    thresholds: { idleAfterMs: 0, maxUnflushedTurns: 1, ...thresholds },
  });
  return { service, bindings, cursors };
}

describe('P1-4 deposit stays inside the engine message budget', () => {
  it('derives the turn bound from the 100-message limit', () => {
    expect(MEMORY_MAX_MESSAGES_PER_DEPOSIT).toBe(100);
    // One turn is two messages, so a deposit can never exceed 100 messages.
    expect(MEMORY_MAX_TURNS_PER_DEPOSIT).toBe(50);
    expect(MEMORY_MAX_TURNS_PER_DEPOSIT * 2).toBeLessThanOrEqual(MEMORY_MAX_MESSAGES_PER_DEPOSIT);
  });

  it('never asks for more turns than one deposit can carry', async () => {
    const db = createDb();
    for (let sequence = 1; sequence <= 80; sequence++) {
      seedTurn(db, 'conv-budget', { id: `t${sequence}`, sequence });
    }
    const port = new RecordingPort();
    const { service } = buildService(db, port, { maxBatchTurns: 1_000 });
    const outcome = await service.flushConversation({
      accountId: ACCOUNT, conversationId: 'conv-budget', force: true,
    });
    expect(port.deposits).toHaveLength(1);
    expect(port.deposits[0]!.batch.turns.length).toBe(MEMORY_MAX_TURNS_PER_DEPOSIT);
    expect(port.deposits[0]!.batch.turns.length * 2).toBeLessThanOrEqual(MEMORY_MAX_MESSAGES_PER_DEPOSIT);
    // A partial batch still advances, so the rest is deposited next pass.
    expect(outcome.advancedTo).toBe(MEMORY_MAX_TURNS_PER_DEPOSIT);
    db.close();
  });

  it('truncates an over-long answer instead of failing the batch', async () => {
    const db = createDb();
    seedTurn(db, 'conv-long', {
      id: 't1', sequence: 1, answer: 'x'.repeat(20_000),
    });
    const port = new RecordingPort();
    const { service } = buildService(db, port);
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-long', force: true });
    const answer = port.deposits[0]!.batch.turns[0]!.assistantAnswer;
    expect(answer.length).toBeLessThanOrEqual(8_192);
    db.close();
  });
});

describe('P1-6 ineligible turns never starve later eligible ones', () => {
  it('filters eligibility in SQL, so 100 failed turns cannot hide turn 101', async () => {
    const db = createDb();
    for (let sequence = 1; sequence <= 100; sequence++) {
      seedTurn(db, 'conv-starve', { id: `f${sequence}`, sequence, status: 'failed' });
    }
    seedTurn(db, 'conv-starve', { id: 'ok', sequence: 101 });
    const port = new RecordingPort();
    const { service } = buildService(db, port);
    const outcome = await service.flushConversation({
      accountId: ACCOUNT, conversationId: 'conv-starve', force: true,
    });
    expect(outcome.error).toBeUndefined();
    expect(port.deposits).toHaveLength(1);
    expect(port.deposits[0]!.batch.turns.map(turn => turn.turnId)).toEqual(['ok']);
    db.close();
  });

  it('skips past a tail of ineligible turns and records the cursor', async () => {
    const db = createDb();
    seedTurn(db, 'conv-tail', { id: 'c1', sequence: 1 });
    for (let sequence = 2; sequence <= 6; sequence++) {
      seedTurn(db, 'conv-tail', { id: `c${sequence}`, sequence, status: 'cancelled' });
    }
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port);
    // First pass deposits the eligible turn.
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-tail', force: true });
    expect(cursors.lastSequence(ACCOUNT, 'conv-tail')).toBe(1);
    // Second pass finds nothing eligible but must not leave the cursor behind.
    const second = await service.flushConversation({
      accountId: ACCOUNT, conversationId: 'conv-tail', force: true,
    });
    expect(second.flushed).toBe(0);
    expect(cursors.lastSequence(ACCOUNT, 'conv-tail')).toBe(6);
    db.close();
  });

  it('does not skip an eligible turn that appears after ineligible ones', async () => {
    const db = createDb();
    seedTurn(db, 'conv-mixed', { id: 'a', sequence: 1, status: 'failed' });
    seedTurn(db, 'conv-mixed', { id: 'b', sequence: 2 });
    const port = new RecordingPort();
    const { service } = buildService(db, port);
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-mixed', force: true });
    expect(port.deposits[0]!.batch.turns.map(turn => turn.turnId)).toEqual(['b']);
    db.close();
  });
});

describe('P2-1 the scheduler ignores fully deposited conversations', () => {
  it('does not list a conversation whose cursor already covers every turn', async () => {
    const db = createDb();
    seedTurn(db, 'conv-done', { id: 't1', sequence: 1 });
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port);
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-done', force: true });

    expect(cursors.listPendingCandidates({
      accountId: ACCOUNT, limit: 10, now: Date.now(), idleAfterMs: 0,
    })).toEqual([]);
    expect(cursors.listOverflowCandidates({
      accountId: ACCOUNT, limit: 10, minUnflushedTurns: 1,
      now: Date.now(), fallbackAfterMs: 2 * 60 * 60 * 1000,
    })).toEqual([]);
    db.close();
  });

  it('forces a flush after two hours even below the turn threshold', () => {
    const db = createDb();
    for (let sequence = 1; sequence <= 3; sequence++) {
      seedTurn(db, 'conv-slow', {
        id: `t${sequence}`, sequence, completedAt: '2026-10-22T00:00:00.000Z',
      });
    }
    const { cursors } = buildService(db, new RecordingPort());
    const now = Date.parse('2026-10-22T02:00:01.000Z');
    expect(cursors.listOverflowCandidates({
      accountId: ACCOUNT, limit: 10, minUnflushedTurns: 20,
      now, fallbackAfterMs: 2 * 60 * 60 * 1000,
    })).toEqual(['conv-slow']);
    // Just before the window it is still outside the fallback.
    expect(cursors.listOverflowCandidates({
      accountId: ACCOUNT, limit: 10, minUnflushedTurns: 20,
      now: now - 2_000, fallbackAfterMs: 2 * 60 * 60 * 1000,
    })).toEqual([]);
    db.close();
  });

  it('ignores failed and cancelled turns for the fallback', () => {
    const db = createDb();
    seedTurn(db, 'conv-failures', {
      id: 't1', sequence: 1, status: 'failed', completedAt: '2026-10-22T00:00:00.000Z',
    });
    seedTurn(db, 'conv-failures', {
      id: 't2', sequence: 2, status: 'cancelled', completedAt: '2026-10-22T00:00:00.000Z',
    });
    const { cursors } = buildService(db, new RecordingPort());
    expect(cursors.listOverflowCandidates({
      accountId: ACCOUNT, limit: 10, minUnflushedTurns: 20,
      now: Date.parse('2026-10-23T00:00:00.000Z'), fallbackAfterMs: 2 * 60 * 60 * 1000,
    })).toEqual([]);
    db.close();
  });

  it('does not move the fallback clock when a deposition fails', async () => {
    const db = createDb();
    seedTurn(db, 'conv-retry', { id: 't1', sequence: 1 });
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port, {
      idleAfterMs: 0, maxUnflushedTurns: 20,
    });
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-retry', force: true });
    const depositedAt = (db.prepare(`SELECT updated_at FROM memory_flush_state
      WHERE account_id = ? AND conversation_id = ?`).get(ACCOUNT, 'conv-retry') as {
        updated_at: string;
      }).updated_at;
    expect(depositedAt).not.toBe('');

    seedTurn(db, 'conv-retry', { id: 't2', sequence: 2 });
    port.fail = true;
    const failed = await service.flushConversation({
      accountId: ACCOUNT, conversationId: 'conv-retry', force: true,
    });
    expect(failed.error).toBeDefined();
    const afterFailure = (db.prepare(`SELECT updated_at FROM memory_flush_state
      WHERE account_id = ? AND conversation_id = ?`).get(ACCOUNT, 'conv-retry') as {
        updated_at: string;
      }).updated_at;
    expect(afterFailure).toBe(depositedAt);

    // Two hours after the successful deposition the still-pending turn is due.
    expect(cursors.listOverflowCandidates({
      accountId: ACCOUNT, limit: 10, minUnflushedTurns: 20,
      now: Date.parse(depositedAt) + 2 * 60 * 60 * 1000 + 1,
      fallbackAfterMs: 2 * 60 * 60 * 1000,
    })).toEqual(['conv-retry']);
    db.close();
  });

  it('still lists a conversation with an undeposited turn', () => {
    const db = createDb();
    seedTurn(db, 'conv-pending', { id: 't1', sequence: 1 });
    const port = new RecordingPort();
    const { cursors } = buildService(db, port);
    expect(cursors.listPendingCandidates({
      accountId: ACCOUNT, limit: 10, now: Date.now(), idleAfterMs: 0,
    })).toEqual(['conv-pending']);
    db.close();
  });
});

describe('P2-4 sanitized provenance reaches the asset', () => {
  it('marks an asset as sanitized when the account redacted a secret', async () => {
    const db = createDb();
    seedTurn(db, 'conv-secret', {
      id: 't1', sequence: 1, user: '我的 key 是 sk-abcdefgh12345678',
    });
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port);
    await service.flushConversation({ accountId: ACCOUNT, conversationId: 'conv-secret', force: true });
    expect(cursors.isSanitized(ACCOUNT, 'conv-secret')).toBe(true);

    const binding = service.bind({ accountId: ACCOUNT, tdaiMemoryId: 'tdai-x' });
    expect(binding.source).toBe('sanitized');
    db.close();
  });

  it('keeps a clean account at conversation provenance', () => {
    const db = createDb();
    const port = new RecordingPort();
    const { service } = buildService(db, port);
    expect(service.bind({ accountId: ACCOUNT, tdaiMemoryId: 'tdai-y' }).source).toBe('conversation');
    db.close();
  });
});

describe('P2-2/P2-3 the Planner sees degradation and only enabled assets', () => {
  function recordRuntimeMode(db: Database.Database, mode: string, detail: string | null = null) {
    db.prepare(`
      INSERT INTO memory_runtime_state (account_id, mode, detail, updated_at)
      VALUES (?, ?, ?, '2026-10-26T00:00:00.000Z')
      ON CONFLICT(account_id) DO UPDATE SET mode = excluded.mode, detail = excluded.detail
    `).run(ACCOUNT, mode, detail);
  }

  it('reports a degraded runtime and never offers a stale candidate', () => {
    const db = createDb();
    const bindings = new MemoryBindingsRepo(db);
    const recall = new MemoryRecallRepo(db);
    const first = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT, content: '偏好中文' });
    recall.replace({
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      candidates: [
        { memoryId: first.memoryId, type: 'instruction', preview: '偏好中文', score: 0.9 },
      ],
    });
    recall.recordDegraded({
      accountId: ACCOUNT, conversationId: 'conv-1', degraded: true, reason: 'engine down',
    });
    recordRuntimeMode(db, 'degraded', 'engine down');

    const reader = new PlannerDataReader(
      db, 'session-1', () => ({ capabilities: [], agents: [] }) as never,
      'conv-1', () => [], ACCOUNT, [],
    );
    const result = reader.searchMemory({});
    // A degraded engine owns no candidate set, even if a previous projection
    // still sits in the database.
    expect(result.items).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('engine down');
    expect(reader.listMemoryAssets().items).toEqual([]);
    db.close();
  });

  it('offers only enabled assets when the runtime is healthy', () => {
    const db = createDb();
    const bindings = new MemoryBindingsRepo(db);
    const recall = new MemoryRecallRepo(db);
    const first = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT, content: '偏好中文' });
    const second = bindings.upsert({ tdaiMemoryId: 'tdai-2', accountId: ACCOUNT, content: '偏好表格' });
    bindings.setEnabled(second.memoryId, ACCOUNT, false);
    recall.replace({
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      candidates: [
        { memoryId: first.memoryId, type: 'instruction', preview: '偏好中文', score: 0.9 },
        { memoryId: second.memoryId, type: 'instruction', preview: '偏好表格', score: 0.8 },
      ],
    });
    recall.recordDegraded({ accountId: ACCOUNT, conversationId: 'conv-1', degraded: false });
    recordRuntimeMode(db, 'enabled');
    const reader = new PlannerDataReader(
      db, 'session-1', () => ({ capabilities: [], agents: [] }) as never,
      'conv-1', () => [], ACCOUNT, [],
    );
    const result = reader.searchMemory({});
    expect(result.items.map(item => item.memoryId)).toEqual([first.memoryId]);
    expect(result.degraded).toBe(false);
    db.close();
  });
});

describe('P2-5 one health verdict for every layer', () => {
  it('treats FTS5 with an abnormal status as not ready', () => {
    expect(interpretEngineHealth({ status: 'degraded', stores: { ftsAvailable: true } }).ready).toBe(false);
    expect(interpretEngineHealth({ status: 'error', stores: { ftsAvailable: true } }).ready).toBe(false);
  });

  it('accepts a healthy engine with or without an explicit status', () => {
    expect(interpretEngineHealth({ status: 'ok', stores: { ftsAvailable: true } }).ready).toBe(true);
    expect(interpretEngineHealth({ status: 'healthy', stores: { ftsAvailable: true } }).ready).toBe(true);
    expect(interpretEngineHealth({ stores: { ftsAvailable: true } }).ready).toBe(true);
  });

  it('never accepts a missing FTS5 store', () => {
    const health = interpretEngineHealth({ status: 'ok', stores: { ftsAvailable: false } });
    expect(health.ready).toBe(false);
    expect(health.detail).toBe('fts5_unavailable');
  });
});

describe('P3 the sidecar does not inherit the Server environment', () => {
  it('passes only the allowlisted variables plus explicit values', () => {
    const environment = buildSidecarEnvironment(
      { TDAI_LLM_API_KEY: 'extraction-key' },
      {
        PATH: '/usr/bin',
        HOME: '/home/user',
        LANG: 'zh_CN.UTF-8',
        FEISHU_APP_SECRET: 'must-not-leak',
        METAWORK_OFFICIAL_TOKEN: 'must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        OPENAI_API_KEY: 'must-not-leak',
      },
    );
    expect(environment.TDAI_LLM_API_KEY).toBe('extraction-key');
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.HOME).toBe('/home/user');
    for (const forbidden of [
      'FEISHU_APP_SECRET', 'METAWORK_OFFICIAL_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY',
    ]) {
      expect(environment, forbidden).not.toHaveProperty(forbidden);
    }
  });
});

describe('P1-7 autoStart and dataDir are honoured', () => {
  const dataRoots: string[] = [];
  afterEach(() => {
    for (const root of dataRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function policy(overrides: { autoStart?: boolean; dataDir?: string }): MemoryRuntimePolicy {
    if (overrides.dataDir) {
      const root = mkdtempSync(join(tmpdir(), 'metawork-memory-datadir-'));
      dataRoots.push(root);
    }
    return {
      mode: 'enabled',
      enabled: true,
      providerRef: 'p',
      modelRef: 'm',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKeyRef: 'file-secret:x',
      modelId: 'model',
      maxResults: 5,
      maxChars: 2_000,
      port: 8_420,
      dataDir: overrides.dataDir ?? null,
      autoStart: overrides.autoStart ?? true,
    };
  }

  it('uses the configured dataDir and falls back to the account default', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-memory-datadir-'));
    dataRoots.push(root);
    expect(resolveDataDir(policy({ dataDir: root }), '/account/default')).toBe(root);
    expect(resolveDataDir(policy({}), '/account/default')).toBe('/account/default');
  });

  it('reads autoStart from the policy', () => {
    expect(resolveMemoryRuntimePolicy({
      schemaVersion: 2,
      providers: {},
      models: {},
      harnesses: {},
      agentClasses: {},
      permissionProfiles: {},
      runtimePolicy: { maxConcurrentAttempts: 1, maxConcurrentAttemptsPerTask: 1 },
      gateway: {},
      memory: { enabled: true, sidecar: { autoStart: false } },
    } as never).autoStart).toBe(false);
  });
});

describe('P1-1 memory is a hot configuration path', () => {
  function configuration(memory: unknown) {
    return {
      schemaVersion: 2,
      providers: {
        p: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyRef: 'file-secret:p',
          region: 'global',
          enabled: true,
        },
      },
      models: {
        m: {
          providerRef: 'p',
          modelId: 'gpt-4o-mini',
          capabilities: ['structured-output'],
          reasoning: 'disabled',
          enabled: true,
        },
      },
      harnesses: {},
      agentClasses: {},
      permissionProfiles: {},
      runtimePolicy: { maxConcurrentAttempts: 1, maxConcurrentAttemptsPerTask: 1 },
      gateway: {},
      ...(memory === undefined ? {} : { memory }),
    };
  }

  it('classifies turning memory on as hot, not restart-required', () => {
    const before = parseAnyFusionConfigurationV2(configuration(undefined));
    const after = parseAnyFusionConfigurationV2(configuration({
      enabled: true, providerRef: 'p', modelRef: 'm',
    }));
    const classification = classifyConfigurationDiff(before, after);
    expect(classification.restartPaths).toEqual([]);
    expect(classification.classification).toBe('hot');
  });

  it('classifies switching the extraction model as hot', () => {
    const before = parseAnyFusionConfigurationV2(configuration({
      enabled: true, providerRef: 'p', modelRef: 'm',
    }));
    const after = parseAnyFusionConfigurationV2(configuration({
      enabled: true, providerRef: 'p', modelRef: 'm', retrieval: { maxResults: 9 },
    }));
    expect(classifyConfigurationDiff(before, after).classification).toBe('hot');
  });

  it('classifies turning memory off as hot', () => {
    const before = parseAnyFusionConfigurationV2(configuration({
      enabled: true, providerRef: 'p', modelRef: 'm',
    }));
    const after = parseAnyFusionConfigurationV2(configuration({ enabled: false }));
    expect(classifyConfigurationDiff(before, after).classification).toBe('hot');
  });
});

describe('P1-2 shutdown deposits what is still pending', () => {
  it('drains pending conversations and waits for the in-flight tick', async () => {
    const db = createDb();
    seedTurn(db, 'conv-shutdown', { id: 't1', sequence: 1 });
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port, {
      // Nothing would ever flush on its own: not idle, below the turn threshold.
      idleAfterMs: 10 * 60 * 1000,
      maxUnflushedTurns: 20,
    });
    const scheduler = new MemoryFlushScheduler({ service, accountId: ACCOUNT, intervalMs: 60_000 });

    const drained = await scheduler.drain();
    expect(drained.error).toBeUndefined();
    expect(drained.flushed).toBe(2);
    expect(port.deposits).toHaveLength(1);
    expect(cursors.lastSequence(ACCOUNT, 'conv-shutdown')).toBe(1);
    db.close();
  });

  it('drains a conversation longer than one batch', async () => {
    const db = createDb();
    for (let sequence = 1; sequence <= 75; sequence++) {
      seedTurn(db, 'conv-long-tail', { id: `t${sequence}`, sequence });
    }
    const port = new RecordingPort();
    const { service, cursors } = buildService(db, port, {
      idleAfterMs: 10 * 60 * 1000, maxUnflushedTurns: 1_000,
    });
    const scheduler = new MemoryFlushScheduler({ service, accountId: ACCOUNT, intervalMs: 60_000 });
    await scheduler.drain();
    expect(cursors.lastSequence(ACCOUNT, 'conv-long-tail')).toBe(75);
    expect(port.deposits.length).toBeGreaterThan(1);
    db.close();
  });

  it('does not throw when the engine is down during shutdown', async () => {
    const db = createDb();
    seedTurn(db, 'conv-down', { id: 't1', sequence: 1 });
    const port = new RecordingPort();
    port.fail = true;
    const { service } = buildService(db, port, { idleAfterMs: 0 });
    const scheduler = new MemoryFlushScheduler({
      service, accountId: ACCOUNT, intervalMs: 60_000, logger: () => undefined,
    });
    await expect(scheduler.drain()).resolves.toMatchObject({ flushed: 0 });
    db.close();
  });
});

describe('schema 53 memory state tables', () => {
  let db: Database.Database | null = null;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db?.close(); db = null; });

  it('installs the deposition and recall state tables', () => {
    const tables = (db!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toContain('memory_flush_state');
    expect(tables).toContain('memory_recall_state');
  });

  it('keeps the cursor monotonic and the sanitized flag sticky', () => {
    const cursors = new MemoryFlushCursorRepo(db!);
    cursors.advance(ACCOUNT, 'conv', 5, true);
    cursors.advance(ACCOUNT, 'conv', 3, false);
    expect(cursors.lastSequence(ACCOUNT, 'conv')).toBe(5);
    expect(cursors.isSanitized(ACCOUNT, 'conv')).toBe(true);
  });
});
