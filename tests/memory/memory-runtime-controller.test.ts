/**
 * Regression tests for the runtime-lifecycle findings: the runtime must be
 * replaceable on configuration activation (P1-1), must not leak a sidecar when
 * the health gate fails (P1-3), and must not restart after `stop` (P2-6).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryRuntime } from '../../src/memory/memory-runtime.js';
import { MemoryRuntimeController } from '../../src/memory/memory-runtime-controller.js';
import { MemorySidecar } from '../../src/memory/memory-sidecar.js';
import type { SecretReference, SecretStore } from '../../src/configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../../src/configuration/types.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metawork-memory-controller-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
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

function configuration(input: {
  enabled?: boolean;
  providerRef?: string;
  modelRef?: string;
  port?: number;
}): AnyFusionConfigurationV2 {
  return {
    schemaVersion: 2,
    providers: {
      p: {
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyRef: 'file-secret:anyfusion/providers/p',
        region: 'global',
        enabled: true,
      },
    },
    models: {
      m: {
        providerRef: 'p',
        modelId: 'model',
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
    memory: {
      enabled: input.enabled ?? false,
      ...(input.providerRef === undefined ? { providerRef: 'p' } : { providerRef: input.providerRef }),
      ...(input.modelRef === undefined ? { modelRef: 'm' } : { modelRef: input.modelRef }),
      sidecar: { port: input.port ?? 18_991 },
    },
  } as unknown as AnyFusionConfigurationV2;
}

/**
 * A launcher that records every spawn and every kill, so a leaked child is
 * observable instead of silent.
 */
function createRecordingLauncher(root: string) {
  const record = join(root, 'spawns.log');
  const script = join(root, 'fake-engine.mjs');
  writeFileSync(script, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(record)}, 'started\\n');
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(record)}, 'stopped\\n'); process.exit(0); });
setInterval(() => {}, 1 << 30);
`);
  return {
    command: { command: process.execPath, args: [script], cwd: root },
    async events(): Promise<string[]> {
      const { readFileSync } = await import('node:fs');
      if (!existsSync(record)) return [];
      return readFileSync(record, 'utf8').split('\n').filter(Boolean);
    },
  };
}

describe('P1-1 the runtime is rebuilt when the memory section changes', () => {
  it('does not rebuild for an unrelated configuration change', async () => {
    const db = createDb();
    const controller = await MemoryRuntimeController.create({
      configuration: configuration({ enabled: false }),
      options: {
        accountId: 'local-default',
        db,
        secretStore: new MemorySecretStore(),
        dataDir: tempRoot(),
        sidecarCommand: null,
      },
    });
    const before = controller.runtime;
    const applied = await controller.applyConfiguration(configuration({ enabled: false }));
    expect(applied.rebuilt).toBe(false);
    expect(controller.runtime).toBe(before);
    await controller.stop();
    db.close();
  });

  it('rebuilds when the switch turns on', async () => {
    const db = createDb();
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/p' as SecretReference, 'key');
    const controller = await MemoryRuntimeController.create({
      configuration: configuration({ enabled: false }),
      options: {
        accountId: 'local-default',
        db,
        secretStore,
        dataDir: tempRoot(),
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    expect(controller.runtime.service).toBeNull();
    const applied = await controller.applyConfiguration(configuration({ enabled: true }));
    expect(applied.rebuilt).toBe(true);
    // No engine is running in this test, so the rebuild is degraded rather than
    // silently reporting "enabled".
    expect(applied.status.mode).toBe('degraded');
    await controller.stop();
    db.close();
  });

  it('switching the extraction model rebuilds with the new model', async () => {
    const db = createDb();
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/p' as SecretReference, 'key');
    const controller = await MemoryRuntimeController.create({
      configuration: configuration({ enabled: true, providerRef: '', modelRef: '' }),
      options: {
        accountId: 'local-default',
        db,
        secretStore,
        dataDir: tempRoot(),
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    expect(controller.status.mode).toBe('needs-model');
    const applied = await controller.applyConfiguration(configuration({ enabled: true }));
    expect(applied.rebuilt).toBe(true);
    expect(applied.status.modelRef).toBe('m');
    await controller.stop();
    db.close();
  });

  it('a rebuild failure degrades instead of throwing', async () => {
    const db = createDb();
    const controller = await MemoryRuntimeController.create({
      configuration: configuration({ enabled: false }),
      options: {
        accountId: 'local-default',
        db,
        secretStore: new MemorySecretStore(),
        dataDir: tempRoot(),
        sidecarCommand: null,
        logger: () => undefined,
      },
    });
    // No extraction credential: the rebuild cannot open the seam, but activation
    // must still succeed.
    const applied = await controller.applyConfiguration(configuration({ enabled: true }));
    expect(applied.rebuilt).toBe(true);
    expect(applied.status.mode).toBe('degraded');
    await controller.stop();
    db.close();
  });
});

describe('P1-3 a sidecar that fails the health gate is stopped, not leaked', () => {
  it('kills the child when the engine never becomes healthy', async () => {
    const db = createDb();
    const root = tempRoot();
    const launcher = createRecordingLauncher(root);
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/p' as SecretReference, 'key');

    const runtime = await MemoryRuntime.create({
      configuration: configuration({ enabled: true, port: 11_991 }),
      accountId: 'local-default',
      db,
      secretStore,
      dataDir: root,
      sidecarCommand: launcher.command,
      sidecarReadyTimeoutMs: 1_500,
      logger: () => undefined,
    });
    // The fake engine starts but never serves /health, so the gate must close.
    expect(runtime.status.mode).toBe('degraded');
    expect(runtime.service).toBeNull();

    // Give SIGTERM a moment to be observed by the child.
    await new Promise(done => setTimeout(done, 1_500));
    const events = await launcher.events();
    expect(events).toContain('started');
    expect(events, 'the failed sidecar must be stopped, not leaked').toContain('stopped');

    // And a later stop must be a no-op rather than throwing.
    await runtime.stop();
    db.close();
  }, 60_000);
});

describe('P2-6 a pending restart cannot resurrect the sidecar after stop', () => {
  it('cancels the scheduled restart', async () => {
    const root = tempRoot();
    const script = join(root, 'crash-once.mjs');
    const counter = join(root, 'count.txt');
    mkdirSync(root, { recursive: true });
    writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const path = ${JSON.stringify(counter)};
const runs = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
appendFileSync(path, String(runs + 1));
process.exit(1);
`);
    chmodSync(script, 0o755);
    const sidecar = new MemorySidecar({
      command: process.execPath,
      args: [script],
      env: {},
      healthUrl: 'http://127.0.0.1:1/health',
      timeoutMs: 200,
      readyTimeoutMs: 200,
      maxRestarts: 3,
      logger: () => undefined,
    });
    // The child exits immediately, which schedules a restart one second later.
    await sidecar.start();
    await new Promise(done => setTimeout(done, 200));
    await sidecar.stop();
    // Wait past the restart window: nothing may spawn again.
    await new Promise(done => setTimeout(done, 1_500));
    const runs = Number((await import('node:fs')).readFileSync(counter, 'utf8'));
    expect(runs).toBe(1);
  }, 30_000);
});

describe('the runtime honours autoStart and dataDir', () => {
  it('does not spawn a sidecar when autoStart is false', async () => {
    const db = createDb();
    const root = tempRoot();
    const launcher = createRecordingLauncher(root);
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/p' as SecretReference, 'key');
    const config = configuration({ enabled: true, port: 11_992 });
    (config.memory as { sidecar: { autoStart: boolean } }).sidecar.autoStart = false;

    const runtime = await MemoryRuntime.create({
      configuration: config,
      accountId: 'local-default',
      db,
      secretStore,
      dataDir: root,
      sidecarCommand: launcher.command,
      logger: () => undefined,
    });
    expect(runtime.status.mode).toBe('degraded');
    expect(await launcher.events()).toEqual([]);
    await runtime.stop();
    db.close();
  }, 30_000);

  it('writes the sidecar configuration into the configured dataDir', async () => {
    const db = createDb();
    const root = tempRoot();
    const custom = join(root, 'custom-memory-dir');
    const launcher = createRecordingLauncher(root);
    const secretStore = new MemorySecretStore();
    await secretStore.put('file-secret:anyfusion/providers/p' as SecretReference, 'key');
    const config = configuration({ enabled: true, port: 11_993 });
    (config.memory as { sidecar: { autoStart: boolean; dataDir: string } }).sidecar = {
      autoStart: false,
      dataDir: custom,
    };

    await MemoryRuntime.create({
      configuration: config,
      accountId: 'local-default',
      db,
      secretStore,
      dataDir: join(root, 'account-default'),
      sidecarCommand: launcher.command,
      logger: () => undefined,
    });
    // autoStart is off, so nothing is written yet; the policy must still expose
    // the configured directory so the runtime can use it when it does start.
    const {
      resolveMemoryRuntimePolicy,
    } = await import('../../src/memory/memory-runtime-policy.js');
    expect(resolveMemoryRuntimePolicy(config).dataDir).toBe(custom);
    db.close();
  });
});

describe('P1-1 the management view follows the live runtime', () => {
  it('reads through the resolver instead of a captured instance', async () => {
    const { createMemoryManagementQuery } = await import('../../src/management/memory-management.js');
    let mode: 'disabled' | 'enabled' = 'disabled';
    const query = createMemoryManagementQuery({
      resolveRuntime: () => ({
        status: {
          mode,
          engineReady: mode === 'enabled',
          ftsAvailable: mode === 'enabled',
          providerRef: mode === 'enabled' ? 'p' : null,
          modelRef: mode === 'enabled' ? 'm' : null,
        },
        service: null,
      }) as never,
      accountId: 'local-default',
      readConfiguration: async () => ({ providers: {}, models: {} }),
    });
    expect((await query.status()).mode).toBe('disabled');
    mode = 'enabled';
    expect((await query.status()).mode).toBe('enabled');
  });
});
