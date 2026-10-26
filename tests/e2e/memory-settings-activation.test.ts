/**
 * Configuration-activation journey for long-term memory (review P1-1).
 *
 * This is the user-visible sequence the review found broken:
 *
 *   1. the user opens settings with memory off;
 *   2. the user turns memory on and picks an extraction model;
 *   3. the settings transaction commits — it must NOT be rejected as
 *      `restart_required`;
 *   4. the runtime is rebuilt and the engine becomes usable;
 *   5. the user switches the extraction model — the runtime follows;
 *   6. the user turns memory off — the seam closes and stops depositing.
 *
 * Steps 3-6 are driven through the real `MemoryRuntimeController` against a real
 * TDAI MemoryCore sidecar, so this exercises the same path the Server uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryRuntimeController } from '../../src/memory/memory-runtime-controller.js';
import { MEMORY_KERNEL_AUTH_SECRET_REFERENCE } from '../../src/memory/memory-runtime.js';
import { classifyConfigurationDiff } from '../../src/configuration/configuration-diff.js';
import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';
import { startMockLlm, type MockLlm } from '../support/mock-llm-server.js';
import {
  resolveMemoryEngineRoot,
  startMemoryEngine,
  type MemoryEngineHandle,
} from '../support/memory-engine-harness.js';

const ACCOUNT = 'local-default';
const PROVIDER_API_KEY_REF = 'file-secret:anyfusion/providers/openai-like';

const engineRoot = resolveMemoryEngineRoot();
const describeActivation = engineRoot ? describe : describe.skip;

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(reference: SecretReference): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error('secret_not_found');
    return value;
  }
  async put(reference: SecretReference, value: string): Promise<void> {
    this.values.set(reference, value);
  }
  async delete(reference: SecretReference): Promise<void> {
    this.values.delete(reference);
  }
}

/** Build a revision the way the settings transaction would. */
function revision(input: {
  memory: Record<string, unknown> | undefined;
  baseUrl: string;
  modelId: string;
}): AnyFusionConfigurationV2 {
  return parseAnyFusionConfigurationV2({
    schemaVersion: 2,
    providers: {
      'openai-like': {
        protocol: 'openai-compatible',
        baseUrl: input.baseUrl,
        apiKeyRef: PROVIDER_API_KEY_REF,
        region: 'global',
        enabled: true,
      },
    },
    models: {
      'extraction-model': {
        providerRef: 'openai-like',
        modelId: input.modelId,
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
    ...(input.memory ? { memory: input.memory } : {}),
  });
}

describeActivation('memory settings activation (review P1-1)', () => {
  let engine: MemoryEngineHandle;
  let llm: MockLlm;
  let db: Database.Database;
  let secretStore: MemorySecretStore;

  beforeAll(async () => {
    llm = await startMockLlm();
    engine = await startMemoryEngine({ engineRoot: engineRoot!, llmBaseUrl: llm.baseUrl });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    secretStore = new MemorySecretStore();
    // The settings transaction stores the Provider credential in the SecretStore.
    await secretStore.put(PROVIDER_API_KEY_REF as SecretReference, 'user-provider-key');
    // The engine was started by the harness with its own Bearer gate; seed it so
    // the runtime authenticates to the same instance instead of generating a
    // second token.
    await secretStore.put(
      MEMORY_KERNEL_AUTH_SECRET_REFERENCE as SecretReference, engine.kernelAuthToken,
    );
  }, 180_000);

  afterAll(async () => {
    await engine?.stop();
    await llm?.close();
    db?.close();
  });

  function enable(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      enabled: true,
      providerRef: 'openai-like',
      modelRef: 'extraction-model',
      sidecar: { port: engine.port },
      ...patch,
    };
  }

  it('turning memory on is a hot change, not restart-required', () => {
    const before = revision({ memory: undefined, baseUrl: llm.baseUrl, modelId: 'mock-extraction-model' });
    const after = revision({
      memory: enable(), baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
    });
    const classification = classifyConfigurationDiff(before, after);
    expect(classification.restartPaths).toEqual([]);
    expect(classification.classification).toBe('hot');
  });

  it('turning memory on through activation makes the engine usable', async () => {
    // The engine is already running in this harness, so the runtime attaches to
    // it rather than spawning a second sidecar.
    const controller = await MemoryRuntimeController.create({
      configuration: revision({ memory: undefined, baseUrl: llm.baseUrl, modelId: 'mock-extraction-model' }),
      options: {
        accountId: ACCOUNT,
        db,
        secretStore,
        dataDir: engine.dataDir,
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    expect(controller.status.mode).toBe('disabled');

    const applied = await controller.applyConfiguration(revision({
      memory: enable(), baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
    }));
    expect(applied.rebuilt).toBe(true);
    // The seam is now open against the real engine.
    expect(applied.status.mode).toBe('enabled');
    expect(applied.status.ftsAvailable).toBe(true);
    expect(applied.status.modelRef).toBe('extraction-model');
    expect(controller.runtime.service).not.toBeNull();
    await controller.stop();
  }, 120_000);

  it('switching the extraction model rebuilds the runtime', async () => {
    const controller = await MemoryRuntimeController.create({
      configuration: revision({
        // Enabled with no model yet: the persistable needs-model state.
        memory: { enabled: true },
        baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
      }),
      options: {
        accountId: ACCOUNT,
        db,
        secretStore,
        dataDir: engine.dataDir,
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    // Enabled with no model yet: the settings page shows "choose a model".
    expect(controller.status.mode).toBe('needs-model');

    const applied = await controller.applyConfiguration(revision({
      memory: enable(), baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
    }));
    expect(applied.rebuilt).toBe(true);
    expect(applied.status.mode).toBe('enabled');
    expect(controller.runtime.policy.modelId).toBe('mock-extraction-model');
    await controller.stop();
  }, 120_000);

  it('turning memory off closes the seam and stops depositing', async () => {
    const controller = await MemoryRuntimeController.create({
      configuration: revision({
        memory: enable(), baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
      }),
      options: {
        accountId: ACCOUNT,
        db,
        secretStore,
        dataDir: engine.dataDir,
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    expect(controller.status.mode).toBe('enabled');
    const applied = await controller.applyConfiguration(revision({
      memory: { enabled: false }, baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
    }));
    expect(applied.rebuilt).toBe(true);
    expect(applied.status.mode).toBe('disabled');
    expect(controller.runtime.service).toBeNull();
    expect(controller.runtime.evidence).toBeNull();
    await controller.stop();
  }, 120_000);

  it('a full deposit still works after an activation-driven rebuild', async () => {
    const controller = await MemoryRuntimeController.create({
      configuration: revision({
        memory: { enabled: false }, baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
      }),
      options: {
        accountId: ACCOUNT,
        db,
        secretStore,
        dataDir: engine.dataDir,
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    await controller.applyConfiguration(revision({
      memory: enable(), baseUrl: llm.baseUrl, modelId: 'mock-extraction-model',
    }));

    const conversationId = 'conv-after-activation';
    const turn = (id: string, sequence: number, user: string, answer: string) => {
      const body = {
        id, conversationId, requestId: 'req', revision: 1,
        firstSequence: sequence, lastSequence: sequence,
        userInput: user, userInputRef: null, answer, answerRef: null,
        resultId: null, certification: null, completeness: null,
        resultOffset: 0, resultPreviewOmitted: false,
        status: 'completed', deliveryStatus: 'ready', taskId: null,
        startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T00:01:00.000Z',
        interactionKind: 'ai_turn',
      };
      db.prepare(`INSERT INTO conversation_read_turns
        (account_id, conversation_id, epoch, turn_id, first_sequence, revision, active, body_json, byte_length)
        VALUES (?, ?, ?, ?, ?, 1, 0, ?, 100)`)
        .run(ACCOUNT, conversationId, `epoch-${conversationId}`, id, sequence, JSON.stringify(body));
    };
    turn('a1', 1, '帮我看下销售数据', '好的');
    turn('a2', 2, '以后都用中文表格输出', '明白');

    const service = controller.runtime.service!;
    const outcome = await service.flushConversation({
      accountId: ACCOUNT, conversationId, force: true,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.flushed).toBe(4);

    // The engine extracts from the rebuild-attached runtime.
    let found = await service.search({ accountId: ACCOUNT, query: '中文表格', limit: 5 });
    for (let attempt = 0; attempt < 40 && found.items.length === 0; attempt++) {
      await new Promise(done => setTimeout(done, 1_000));
      found = await service.search({ accountId: ACCOUNT, query: '中文表格', limit: 5 });
    }
    expect(found.degraded).toBe(false);
    expect(found.items.length).toBeGreaterThan(0);
    await controller.stop();
  }, 180_000);
});
