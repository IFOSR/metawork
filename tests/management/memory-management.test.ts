import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  classifyMemoryEngineProblem,
  createMemoryManagementQuery,
} from '../../src/management/memory-management.js';
import { MemoryRuntime } from '../../src/memory/memory-runtime.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';

const ACCOUNT = 'local-default';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const configuration = {
  providers: {
    'openai-like': {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
      displayName: 'OpenAI-like',
    },
    anthropic: {
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      enabled: true,
      displayName: 'Anthropic',
    },
    disabled: {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      enabled: false,
      displayName: 'Disabled',
    },
  },
  models: {
    'extraction-model': {
      providerRef: 'openai-like',
      modelId: 'gpt-4o-mini',
      description: 'GPT-4o mini',
      capabilities: ['structured-output'],
      enabled: true,
      costInputPerMillion: 1,
      costOutputPerMillion: 2,
    },
    'chat-only': {
      providerRef: 'openai-like',
      modelId: 'gpt-4o',
      capabilities: ['coding'],
      enabled: true,
    },
  },
};

/** A runtime stub that reports one mode without any engine interaction. */
function stubRuntime(mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded', service: unknown = null) {
  return {
    status: {
      mode,
      detail: mode === 'degraded' ? 'memory_engine_unreachable' : undefined,
      engineReady: mode === 'enabled',
      ftsAvailable: mode === 'enabled',
      providerRef: mode === 'enabled' ? 'openai-like' : null,
      modelRef: mode === 'enabled' ? 'extraction-model' : null,
    },
    service,
    evidence: null,
    recall: null,
  } as unknown as MemoryRuntime;
}

describe('memory management view', () => {
  let db: Database.Database;

  beforeEach(() => { db = createDb(); });

  it('reports the disabled mode and lists no assets', async () => {
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('disabled'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    const status = await query.status();
    expect(status.enabled).toBe(false);
    expect(status.mode).toBe('disabled');
    expect(status.providerRef).toBeNull();
    expect(await query.listAssets({ limit: 20, offset: 0 })).toEqual({
      items: [], total: 0, mode: 'disabled', degraded: false,
    });
    expect(await query.setEnabled({ memoryId: 'mem-1', enabled: false })).toBeNull();
    expect(await query.deleteAsset({ memoryId: 'mem-1' })).toBe(false);
  });

  it('never presents a degraded engine as an empty asset list', async () => {
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('degraded'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    expect(await query.listAssets({ limit: 20, offset: 0 })).toEqual({
      items: [],
      total: 0,
      mode: 'degraded',
      degraded: true,
      degradedReason: 'memory_engine_unreachable',
    });
  });

  it('separates "engine not installed" from "engine without FTS5"', () => {
    expect(classifyMemoryEngineProblem({
      mode: 'degraded',
      engineReady: false,
      ftsAvailable: false,
      detail: 'memory sidecar installation not found (/x/memory/tdai) (health_unreachable: boom)',
    })).toBe('engine_missing');
    expect(classifyMemoryEngineProblem({
      mode: 'degraded',
      engineReady: false,
      ftsAvailable: false,
      detail: 'fts5_unavailable',
    })).toBe('fts5_unavailable');
    expect(classifyMemoryEngineProblem({
      mode: 'degraded',
      engineReady: false,
      ftsAvailable: false,
      detail: 'health_unreachable: ECONNREFUSED',
    })).toBe('engine_unreachable');
    expect(classifyMemoryEngineProblem({
      mode: 'needs-model',
      engineReady: false,
      ftsAvailable: false,
    })).toBe('extraction_model_required');
    expect(classifyMemoryEngineProblem({
      mode: 'enabled',
      engineReady: true,
      ftsAvailable: true,
    })).toBeUndefined();
    expect(classifyMemoryEngineProblem({
      mode: 'disabled',
      engineReady: false,
      ftsAvailable: false,
    })).toBeUndefined();
  });

  it('exposes the engine problem on the disabled and degraded status views', async () => {
    const disabled = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('disabled'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    expect((await disabled.status()).engineProblem).toBeUndefined();

    const degraded = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('degraded'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    expect((await degraded.status()).engineProblem).toBe('engine_unreachable');
  });

  it('asks for an extraction model when the switch is on without one', async () => {
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('needs-model'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    const status = await query.status();
    expect(status.enabled).toBe(false);
    expect(status.mode).toBe('needs-model');
  });

  it('marks providers that cannot be used for extraction', async () => {
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('enabled'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    const status = await query.status();
    const anthropic = status.selectableProviders.find(provider => provider.providerRef === 'anthropic');
    const disabled = status.selectableProviders.find(provider => provider.providerRef === 'disabled');
    const usable = status.selectableProviders.find(provider => provider.providerRef === 'openai-like');
    expect(anthropic?.unsupportedReason).toBe('provider_protocol_anthropic_unsupported');
    expect(disabled?.unsupportedReason).toBe('provider_disabled');
    expect(usable?.unsupportedReason).toBeUndefined();
  });

  it('exposes models with their structured-output capability and price', async () => {
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('enabled'),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });
    const status = await query.status();
    const provider = status.selectableProviders.find(item => item.providerRef === 'openai-like')!;
    const extraction = provider.models.find(model => model.modelRef === 'extraction-model')!;
    const chatOnly = provider.models.find(model => model.modelRef === 'chat-only')!;
    expect(extraction.supportsStructuredOutput).toBe(true);
    expect(extraction.costInputPerMillion).toBe(1);
    expect(chatOnly.supportsStructuredOutput).toBe(false);
    expect(status.modelName).toBe('GPT-4o mini');
    expect(status.modelPricing).toEqual({ costInputPerMillion: 1, costOutputPerMillion: 2 });
  });

  it('lists, disables and deletes the account assets', async () => {
    const bindings = new MemoryBindingsRepo(db);
    const first = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT, workspaceId: 'ws-1', content: '偏好中文表格' });
    bindings.upsert({ tdaiMemoryId: 'tdai-2', accountId: 'account-b' });
    const service = {
      listAssets: async () => ({
        items: [{
          id: 'tdai-1', memoryId: first.memoryId, type: 'instruction', content: '偏好中文表格',
          background: null, createdAt: '', updatedAt: '', source: 'conversation',
          workspaceId: 'ws-1', enabled: true,
        }],
        total: 1,
      }),
      setEnabled: async (input: { accountId: string; memoryId: string; enabled: boolean }) => (
        bindings.setEnabled(input.memoryId, input.accountId, input.enabled)
      ),
      deleteAsset: async (input: { accountId: string; memoryId: string }) => (
        bindings.delete(input.memoryId, input.accountId)
      ),
    };
    const query = createMemoryManagementQuery({
      resolveRuntime: () => stubRuntime('enabled', service),
      accountId: ACCOUNT,
      readConfiguration: async () => configuration,
    });

    const assets = await query.listAssets({ limit: 20, offset: 0 });
    expect(assets.mode).toBe('enabled');
    expect(assets.degraded).toBe(false);
    expect(assets.total).toBe(1);
    expect(assets.items[0]!.preview).toContain('中文表格');
    expect(assets.items[0]!.workspaceId).toBe('ws-1');

    expect(await query.setEnabled({ memoryId: first.memoryId, enabled: false }))
      .toMatchObject({ enabled: false });
    // Another account's asset is invisible to this one.
    const foreign = bindings.findByTdaiMemoryId('tdai-2', 'account-b')!;
    expect(await query.setEnabled({ memoryId: foreign.memoryId, enabled: false })).toBeNull();
    expect(await query.deleteAsset({ memoryId: foreign.memoryId })).toBe(false);

    expect(await query.deleteAsset({ memoryId: first.memoryId })).toBe(true);
  });
});
