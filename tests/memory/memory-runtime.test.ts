import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryRuntime, MEMORY_KERNEL_AUTH_SECRET_REFERENCE } from '../../src/memory/memory-runtime.js';
import { MemorySidecar } from '../../src/memory/memory-sidecar.js';
import { MemoryFlushScheduler } from '../../src/memory/memory-flush-scheduler.js';
import { resolveMemorySidecarCommand } from '../../src/memory/memory-sidecar-command.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

function memoryConfiguration(overrides: {
  enabled?: boolean;
  providerRef?: string;
  modelRef?: string;
} = {}): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      'openai-like': {
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/openai-like',
        region: 'global',
        enabled: true,
      },
    },
    models: {
      'extraction-model': {
        providerRef: 'openai-like',
        modelId: 'm',
        capabilities: ['structured-output'],
        reasoning: 'disabled',
        enabled: true,
      },
    },
    harnesses: {},
    agentClasses: {},
    permissionProfiles: {},
    runtimePolicy: { maxConcurrentAttempts: 2, maxConcurrentAttemptsPerTask: 1 },
    gateway: {},
    memory: {
      enabled: overrides.enabled ?? true,
      ...(overrides.providerRef === undefined ? { providerRef: 'openai-like' } : { providerRef: overrides.providerRef }),
      ...(overrides.modelRef === undefined ? { modelRef: 'extraction-model' } : { modelRef: overrides.modelRef }),
      sidecar: { port: 18_999 },
    },
  } as unknown as AnyFusionConfigurationV2;
}

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

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metawork-memory-runtime-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MemoryRuntime', () => {
  function createDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  }

  it('creates nothing when memory is disabled', async () => {
    const db = createDb();
    const runtime = await MemoryRuntime.create({
      configuration: memoryConfiguration({ enabled: false }),
      accountId: 'local-default',
      db,
      secretStore: new MemorySecretStore(),
      dataDir: tempRoot(),
    });
    expect(runtime.status.mode).toBe('disabled');
    expect(runtime.service).toBeNull();
    expect(runtime.evidence).toBeNull();
    // The recall read model exists so disabling memory can retire candidates
    // projected by the previous runtime.
    expect(runtime.recall).not.toBeNull();
    expect(db.prepare('SELECT mode FROM memory_runtime_state WHERE account_id = ?')
      .get('local-default')).toEqual({ mode: 'disabled' });
    db.close();
  });

  it('reports needs-model when the switch is on without a model', async () => {
    const db = createDb();
    const configuration = memoryConfiguration();
    delete (configuration as { memory?: unknown }).memory;
    (configuration as { memory?: unknown }).memory = { enabled: true };
    const runtime = await MemoryRuntime.create({
      configuration,
      accountId: 'local-default',
      db,
      secretStore: new MemorySecretStore(),
      dataDir: tempRoot(),
    });
    expect(runtime.status.mode).toBe('needs-model');
    expect(runtime.status.detail).toBe('memory_extraction_model_required');
    expect(runtime.service).toBeNull();
    db.close();
  });

  it('refuses to open the seam when the extraction credential is missing', async () => {
    const db = createDb();
    const runtime = await MemoryRuntime.create({
      configuration: memoryConfiguration(),
      accountId: 'local-default',
      db,
      secretStore: new MemorySecretStore(),
      dataDir: tempRoot(),
    });
    expect(runtime.status.mode).toBe('degraded');
    expect(runtime.status.detail).toBe('memory_extraction_credential_missing');
    expect(runtime.service).toBeNull();
    db.close();
  });

  it('stays degraded when the engine cannot be reached', async () => {
    const db = createDb();
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/openai-like' as SecretReference, 'test-key');
    const runtime = await MemoryRuntime.create({
      configuration: memoryConfiguration(),
      accountId: 'local-default',
      db,
      secretStore,
      dataDir: tempRoot(),
      sidecarCommand: null,
      sidecarUnavailableReason: 'memory_sidecar_not_installed',
    });
    expect(runtime.status.mode).toBe('degraded');
    expect(runtime.status.detail).toContain('memory_sidecar_not_installed');
    expect(runtime.service).toBeNull();
    db.close();
  });

  it('never writes an engine credential into the Server environment', async () => {
    const db = createDb();
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/openai-like' as SecretReference, 'super-secret-key');
    const before = { ...process.env };
    await MemoryRuntime.create({
      configuration: memoryConfiguration(),
      accountId: 'local-default',
      db,
      secretStore,
      dataDir: tempRoot(),
      sidecarCommand: null,
    });
    for (const [name, value] of Object.entries(process.env)) {
      if (before[name] !== value && value?.includes('super-secret-key')) {
        throw new Error(`memory credential leaked into process.env as ${name}`);
      }
    }
    expect(process.env.TDAI_LLM_API_KEY).toBe(before.TDAI_LLM_API_KEY);
    db.close();
  });
});

describe('MemoryFlushScheduler', () => {
  it('contains a failing tick and records the error', async () => {
    const scheduler = new MemoryFlushScheduler({
      service: {
        flushPending: async () => { throw new Error('engine down'); },
      } as never,
      accountId: 'local-default',
      intervalMs: 60_000,
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.status.lastError).toBe('engine down');
    expect(scheduler.status.lastRunAt).not.toBeNull();
  });

  it('is not running until started and stops cleanly', () => {
    const scheduler = new MemoryFlushScheduler({
      service: { flushPending: async () => [] } as never,
      accountId: 'local-default',
      intervalMs: 60_000,
    });
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });
});

describe('MemorySidecar', () => {
  it('reports not-ready when the health endpoint is unreachable', async () => {
    const sidecar = new MemorySidecar({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      healthUrl: 'http://127.0.0.1:1/health',
      timeoutMs: 300,
      readyTimeoutMs: 300,
      maxRestarts: 0,
    });
    const status = await sidecar.start();
    expect(status.healthy).toBe(false);
    expect(status.ftsAvailable).toBe(false);
    await sidecar.stop();
  });
});

describe('resolveMemorySidecarCommand', () => {
  it('finds an explicit installation directory', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src', 'gateway'), { recursive: true });
    writeFileSync(join(root, 'src', 'gateway', 'server.ts'), '// stub');
    const resolution = resolveMemorySidecarCommand({
      env: { METAWORK_MEMORY_SIDECAR_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(resolution.command).not.toBeNull();
    expect(resolution.command!.cwd).toBe(root);
    expect(resolution.command!.args).toContain('--import');
  });

  it('prefers the compiled gateway shipped by releases', () => {
    const installRoot = tempRoot();
    const sidecarRoot = join(installRoot, 'memory', 'tdai');
    mkdirSync(join(sidecarRoot, 'dist', 'gateway'), { recursive: true });
    writeFileSync(join(sidecarRoot, 'dist', 'gateway', 'server.js'), '// compiled');
    const resolution = resolveMemorySidecarCommand({ installRoot, env: {} as NodeJS.ProcessEnv });
    expect(resolution.command?.cwd).toBe(sidecarRoot);
    expect(resolution.command?.args).toEqual([join(sidecarRoot, 'dist', 'gateway', 'server.js')]);
    expect(resolution.command?.args).not.toContain('--import');
  });

  it('finds a managed installation under the install root', () => {
    const installRoot = tempRoot();
    const sidecarRoot = join(installRoot, 'memory', 'tdai');
    mkdirSync(join(sidecarRoot, 'src', 'gateway'), { recursive: true });
    writeFileSync(join(sidecarRoot, 'src', 'gateway', 'server.ts'), '// stub');
    const resolution = resolveMemorySidecarCommand({ installRoot, env: {} as NodeJS.ProcessEnv });
    expect(resolution.command?.cwd).toBe(sidecarRoot);
  });

  it('explains why no sidecar was resolved', () => {
    const installRoot = tempRoot();
    const resolution = resolveMemorySidecarCommand({ installRoot, env: {} as NodeJS.ProcessEnv });
    expect(resolution.command).toBeNull();
    expect(resolution.reason).toContain('not found');
  });
});
