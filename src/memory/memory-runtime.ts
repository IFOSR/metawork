/**
 * MemoryRuntime — the Server-side composition of the memory capability.
 *
 * Responsibilities:
 *   - honour the product switch: when memory is off there is no sidecar, no
 *     request, no model cost and no index (design D5);
 *   - read the extraction credential and the account user key from the
 *     SecretStore on demand and inject them into the sidecar environment only —
 *     never into the Server's own `process.env`, which the Planner process tree
 *     inherits (design §6.4);
 *   - refuse to open the memory seam unless the engine reports a usable health
 *     state, including the blocking BM25/FTS5 gate (design R2);
 *   - own the flush scheduler and the sidecar lifecycle, including a final
 *     deposition on shutdown (design §5.2).
 *
 * The runtime is the only MetaWork component that talks to the engine.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SecretReference, SecretStore } from '../configuration/secret-store.js';
import { MemoryBindingsRepo } from '../storage/memory-bindings-repo.js';
import { MemoryFlushCursorRepo } from '../storage/memory-flush-cursor-repo.js';
import { MemoryRecallRepo } from '../storage/memory-recall-repo.js';
import { SqliteMemoryTurnSource } from '../storage/memory-turn-source.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { MemoryEvidenceService } from './memory-evidence-service.js';
import { MemoryFlushScheduler } from './memory-flush-scheduler.js';
import { MemorySanitizer } from './memory-sanitizer.js';
import { MemoryService } from './memory-service.js';
import { MemorySidecar } from './memory-sidecar.js';
import { renderMemorySidecarConfig, KERNEL_AUTH_TOKEN_ENV_VAR } from './memory-sidecar-config.js';
import { TdaiMemoryAdapter } from './tdai-memory-adapter.js';
import { resolveMemoryRuntimePolicy, type MemoryRuntimePolicy } from './memory-runtime-policy.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import type { MemorySearchCandidate } from './memory-types.js';

export interface MemorySidecarCommand {
  command: string;
  args: readonly string[];
  cwd?: string;
}

export interface MemoryRuntimeOptions {
  configuration: AnyFusionConfigurationV2;
  accountId: string;
  db: Database.Database;
  secretStore: SecretStore;
  /** Default account directory for the engine's data and configuration. */
  dataDir: string;
  /** How to launch the engine. When absent the engine must already be running. */
  sidecarCommand?: MemorySidecarCommand | null;
  /** Why no sidecar command was resolved, surfaced when the engine is unreachable. */
  sidecarUnavailableReason?: string;
  /** How long to wait for a freshly spawned engine to become usable. */
  sidecarReadyTimeoutMs?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface MemoryRuntimeStatus {
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  detail?: string;
  engineReady: boolean;
  ftsAvailable: boolean;
  providerRef: string | null;
  modelRef: string | null;
}

const RECALL_PREVIEW_CHARS = 240;

/** Secret reference that holds the memory engine Bearer gate. */
export const MEMORY_KERNEL_AUTH_SECRET_REFERENCE = 'file-secret:anyfusion/memory/kernel-auth-token' as const;
/**
 * Secret reference for the installation-level, read-only engine user key.
 *
 * One MetaWork installation is one local Server for one local customer, and the
 * SecretStore lives inside that installation's own data directory. The key is
 * therefore an installation/Server secret, not a shared global credential and
 * not yet a per-account credential. It is optional: the v3 data plane is gated
 * by the Bearer token plus `x-tdai-service-id`, and MetaWork isolates by the
 * account-derived scope triple. When the reference exists the runtime sends it,
 * so a deployment that requires the user key authenticates correctly, and the
 * key can be revoked independently of the Server.
 */
export const MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE = 'file-secret:anyfusion/memory/user-key' as const;

export class MemoryRuntime {
  private scheduler: MemoryFlushScheduler | null = null;
  private sidecar: MemorySidecar | null = null;
  private stopping = false;
  private constructor(
    readonly service: MemoryService | null,
    readonly evidence: MemoryEvidenceService | null,
    readonly recall: MemoryRecallRepo | null,
    readonly policy: MemoryRuntimePolicy,
    private detail: string | undefined,
    private readonly logger: (message: string) => void,
    private readonly accountId: string,
  ) {}

  static async create(options: MemoryRuntimeOptions): Promise<MemoryRuntime> {
    const logger = options.logger ?? ((message: string) => console.error(message));
    const policy = resolveMemoryRuntimePolicy(options.configuration);
    // The recall read model exists even when the engine does not, so turning
    // memory off can retire candidates projected by the previous runtime.
    const recallRepo = new MemoryRecallRepo(options.db);
    const runtime = new MemoryRuntime(null, null, recallRepo, policy, undefined, logger, options.accountId);

    if (policy.mode === 'disabled') {
      runtime.detail = 'memory_disabled';
      runtime.recordRuntimeState(options.db);
      return runtime;
    }
    if (policy.mode === 'needs-model') {
      // Design §7.2: the switch is on but no extraction model is chosen. The
      // settings page asks for one; nothing is deposited or extracted.
      runtime.detail = 'memory_extraction_model_required';
      runtime.recordRuntimeState(options.db);
      return runtime;
    }

    const bindings = new MemoryBindingsRepo(options.db);
    const cursors = new MemoryFlushCursorRepo(options.db);
    const turns = new SqliteMemoryTurnSource(options.db);

    const extractionKey = policy.apiKeyRef
      ? await readSecret(options.secretStore, policy.apiKeyRef, logger, 'extraction credential')
      : '';
    if (!extractionKey) {
      runtime.detail = 'memory_extraction_credential_missing';
      runtime.recordRuntimeState(options.db);
      return runtime;
    }

    // Design §6.5/§6.4: optional account-level read-only user key.
    const userKey = await readSecret(
      options.secretStore, MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE, logger, 'user key',
    );
    const kernelAuthToken = await resolveKernelAuthToken(options);

    const baseUrl = `http://127.0.0.1:${policy.port}`;
    let sidecar: MemorySidecar | null = null;
    const shouldStart = options.sidecarCommand !== null
      && options.sidecarCommand !== undefined
      && policy.autoStart;
    if (shouldStart && options.sidecarCommand) {
      const dataDir = resolveDataDir(policy, options.dataDir);
      const configPath = writeMemorySidecarConfig({
        dataDir,
        port: policy.port,
        baseUrl: policy.baseUrl ?? '',
        model: policy.modelId ?? '',
      });
      sidecar = new MemorySidecar({
        command: options.sidecarCommand.command,
        args: options.sidecarCommand.args,
        ...(options.sidecarCommand.cwd ? { cwd: options.sidecarCommand.cwd } : {}),
        env: {
          TDAI_GATEWAY_CONFIG: configPath,
          TDAI_GATEWAY_PORT: String(policy.port),
          TDAI_GATEWAY_HOST: '127.0.0.1',
          TDAI_DATA_DIR: dataDir,
          TDAI_LLM_API_KEY: extractionKey,
          TDAI_LLM_BASE_URL: policy.baseUrl ?? '',
          TDAI_LLM_MODEL: policy.modelId ?? '',
          [KERNEL_AUTH_TOKEN_ENV_VAR]: kernelAuthToken,
        },
        healthUrl: `${baseUrl}/health`,
        ...(options.sidecarReadyTimeoutMs
          ? { readyTimeoutMs: options.sidecarReadyTimeoutMs }
          : {}),
        logger,
      });
      // Adopt the child immediately so a failed health gate can still stop it
      // (review P1-3).
      runtime.sidecar = sidecar;
      await sidecar.start();
    }

    const health = sidecar ? await sidecar.probe() : await probeEngine(baseUrl);
    if (!health.ready) {
      // The gate is blocking: an unusable engine must not look like an empty
      // memory. The sidecar we just started is stopped rather than leaked.
      const reason = sidecar
        ? health.detail ?? 'memory_bm25_unavailable'
        : options.sidecarUnavailableReason
          ? `${options.sidecarUnavailableReason} (${health.detail ?? 'unreachable'})`
          : health.detail ?? 'memory_engine_unreachable';
      logger(`memory engine is not usable: ${reason}`);
      await runtime.stopSidecar();
      runtime.detail = reason;
      runtime.recordRuntimeState(options.db);
      return runtime;
    }

    const adapter = new TdaiMemoryAdapter({
      baseUrl,
      serviceId: 'metawork',
      kernelAuthToken,
      ...(userKey ? { userKey } : {}),
      timeoutMs: 10_000,
    });
    const service = new MemoryService({
      port: adapter,
      bindings,
      cursors,
      turns,
      sanitizer: new MemorySanitizer(),
      logger,
    });
    const evidence = new MemoryEvidenceService({
      resolveService: () => service,
      evidenceRepo: new TaskExecutionEvidenceRepo(options.db),
      // `retrieval.maxChars` bounds what the evidence catalog stores; the 4k
      // prompt budget is applied later, so the Executor can still page the rest.
      maxStoredChars: Math.max(4_000, policy.maxChars),
      logger,
    });
    const ready = new MemoryRuntime(
      service, evidence, recallRepo, policy, undefined, logger, options.accountId,
    );
    ready.sidecar = runtime.sidecar;
    runtime.sidecar = null;
    ready.attachScheduler(options);
    ready.recordRuntimeState(options.db);
    return ready;
  }

  /**
   * Persist the runtime mode for the Planner and management readers. The
   * Planner process cannot ask the Server directly, and a disabled runtime has
   * no per-conversation recall row yet, so the gate needs its own durable fact.
   */
  private recordRuntimeState(db: Database.Database): void {
    const status = this.status;
    db.prepare(`
      INSERT INTO memory_runtime_state (account_id, mode, detail, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        mode = excluded.mode, detail = excluded.detail, updated_at = excluded.updated_at
    `).run(this.accountId, status.mode, status.detail ?? null, new Date().toISOString());
  }

  private attachScheduler(options: MemoryRuntimeOptions): void {
    if (!this.service) return;
    this.scheduler = new MemoryFlushScheduler({
      service: this.service,
      accountId: options.accountId,
      intervalMs: 60_000,
      ...(options.now ? { now: options.now } : {}),
      logger: this.logger,
    });
    this.scheduler.start();
  }

  get status(): MemoryRuntimeStatus {
    const engineReady = this.sidecar?.status.healthy ?? Boolean(this.service);
    return {
      mode: this.service ? 'enabled' : this.policy.mode === 'enabled' ? 'degraded' : this.policy.mode,
      ...(this.detail ? { detail: this.detail } : {}),
      engineReady,
      ftsAvailable: this.sidecar?.status.ftsAvailable ?? Boolean(this.service),
      providerRef: this.policy.providerRef,
      modelRef: this.policy.modelRef,
    };
  }

  /**
   * Refresh the Planner-facing recall read model for one conversation.
   * Failures are swallowed: memory never blocks a Planner turn.
   */
  async refreshRecall(input: {
    accountId: string;
    conversationId: string;
    query: string;
    workspaceId?: string | null;
  }): Promise<void> {
    if (!this.recall) return;
    if (!this.service) {
      // Disabled, needs-model and degraded runtimes own no asset. A candidate
      // projected by a previous runtime must never stay readable by the
      // Planner, and the state must say why the list is empty.
      this.recall.clear(input.accountId, input.conversationId);
      this.recall.recordDegraded({
        accountId: input.accountId,
        conversationId: input.conversationId,
        degraded: true,
        reason: this.detail ?? this.status.mode,
      });
      return;
    }
    try {
      const result = await this.service.search({
        accountId: input.accountId,
        query: input.query,
        limit: this.policy.maxResults,
      });
      // Design §6.1/§6.6: a degraded engine must be visible to the Planner, so
      // it can distinguish "no matching memory" from "the engine is down".
      this.recall.recordDegraded({
        accountId: input.accountId,
        conversationId: input.conversationId,
        degraded: result.degraded,
        ...(result.degradedReason ? { reason: result.degradedReason } : {}),
      });
      if (result.degraded) {
        // An unavailable engine owns no valid candidate set either; keeping the
        // previous projection would offer assets the Runtime cannot materialize.
        this.recall.clear(input.accountId, input.conversationId);
        return;
      }
      if (!result.items.length) {
        this.recall.replace({
          accountId: input.accountId,
          conversationId: input.conversationId,
          candidates: [],
        });
        return;
      }
      // Bind every candidate so the Planner sees the same ids the Runtime will
      // validate, and so a recalled asset becomes governable.
      const candidates = result.items.map((item: MemorySearchCandidate) => {
        const binding = this.service!.bind({
          accountId: input.accountId,
          tdaiMemoryId: item.id,
          workspaceId: input.workspaceId ?? null,
          content: item.content,
        });
        return {
          memoryId: binding.memoryId,
          type: item.type,
          preview: item.content.slice(0, RECALL_PREVIEW_CHARS),
          score: item.score,
        };
      });
      this.recall.replace({
        accountId: input.accountId,
        conversationId: input.conversationId,
        candidates,
      });
    } catch (error) {
      this.logger(`memory recall refresh failed: ${(error as Error).message}`);
      this.recall.clear(input.accountId, input.conversationId);
      this.recall.recordDegraded({
        accountId: input.accountId,
        conversationId: input.conversationId,
        degraded: true,
        reason: (error as Error).message,
      });
    }
  }

  /**
   * Final deposition before shutdown (design §5.2: `Server 关闭` is a fallback
   * trigger). Never throws.
   */
  async drain(): Promise<{ flushed: number; conversations: number; error?: string }> {
    if (!this.scheduler) return { flushed: 0, conversations: 0 };
    return this.scheduler.drain();
  }

  private async stopSidecar(): Promise<void> {
    const sidecar = this.sidecar;
    this.sidecar = null;
    await sidecar?.stop();
  }

  /**
   * Stop the capability. Deposits what is still pending first, so a conversation
   * that never reached the idle window is not lost (review P1-2), then stops the
   * scheduler and the sidecar.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.drain();
    } catch (error) {
      this.logger(`memory shutdown drain failed: ${(error as Error).message}`);
    }
    this.scheduler?.stop();
    this.scheduler = null;
    await this.stopSidecar();
  }
}

/** Apply `memory.sidecar.dataDir` when configured, else the account default. */
export function resolveDataDir(policy: MemoryRuntimePolicy, fallback: string): string {
  return policy.dataDir && policy.dataDir.trim() ? policy.dataDir : fallback;
}

async function readSecret(
  store: SecretStore,
  reference: string,
  logger: (message: string) => void,
  label: string,
): Promise<string> {
  try {
    return await store.get(reference as SecretReference);
  } catch (error) {
    logger(`memory ${label} unavailable: ${(error as Error).message}`);
    return '';
  }
}

/** Write the sidecar configuration file for the engine to read on startup. */
export function writeMemorySidecarConfig(input: {
  dataDir: string;
  port: number;
  baseUrl: string;
  model: string;
  serviceId?: string;
}): string {
  const path = `${input.dataDir}/tdai-gateway.standalone.yaml`;
  const contents = renderMemorySidecarConfig({
    port: input.port,
    dataDir: input.dataDir,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKeyEnvVar: 'TDAI_LLM_API_KEY',
    serviceId: input.serviceId ?? 'metawork',
  });
  mkdirSync(input.dataDir, { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/**
 * The engine Bearer gate. It is generated once per installation and stored in
 * the account SecretStore, so that a restart keeps the same gate without ever
 * writing it into the Server environment.
 */
async function resolveKernelAuthToken(options: MemoryRuntimeOptions): Promise<string> {
  const reference = MEMORY_KERNEL_AUTH_SECRET_REFERENCE;
  try {
    const existing = await options.secretStore.get(reference);
    if (existing) return existing;
  } catch {
    // The secret does not exist yet; generate one below.
  }
  const token = randomBytes(32).toString('base64url');
  try {
    await options.secretStore.put(reference, token);
  } catch (error) {
    options.logger?.(`memory kernel auth token could not be persisted: ${(error as Error).message}`);
  }
  return token;
}

async function probeEngine(baseUrl: string): Promise<{ ready: boolean; ftsAvailable: boolean; detail?: string }> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ready: false, ftsAvailable: false, detail: `health_http_${response.status}` };
    const body = await response.json() as {
      status?: string;
      version?: string;
      stores?: { ftsAvailable?: boolean };
    };
    const { interpretEngineHealth } = await import('./memory-sidecar.js');
    return interpretEngineHealth(body);
  } catch (error) {
    return { ready: false, ftsAvailable: false, detail: `health_unreachable: ${(error as Error).message}` };
  }
}
