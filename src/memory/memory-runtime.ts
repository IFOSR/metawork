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
import { createMemoryUsageDrainer } from './memory-usage.js';
import { MemorySanitizer } from './memory-sanitizer.js';
import { MemoryService } from './memory-service.js';
import { MemorySidecar } from './memory-sidecar.js';
import { renderMemorySidecarConfig, KERNEL_AUTH_TOKEN_ENV_VAR } from './memory-sidecar-config.js';
import { TdaiMemoryAdapter } from './tdai-memory-adapter.js';
import { resolveMemoryRuntimePolicy, type MemoryRuntimePolicy } from './memory-runtime-policy.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import type { LayeredMemoryRecall, MemoryLayer, MemoryRecallItem, MemorySearchCandidate } from './memory-types.js';

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
  /**
   * Metring seam for the engine's own model calls (extraction/scene/persona).
   * The engine owns that call site, so MetaWork records the tokens it drains
   * from the authenticated usage route.
   */
  usageObserver?: (event: import('../metering/usage-normalizer.js').RawUsageEvent) => void;
  resolveUsagePayer?: import('../metering/usage-payer.js').UsagePayerResolver;
  queryLifecycle?: Pick<import('../metering/query-lifecycle.js').QueryUsageLifecycle, 'beginQuery'>;
  /** Pinned configuration revision this runtime was built for. */
  configurationRevision?: string;
}

export interface MemoryRuntimeStatus {
  mode: 'disabled' | 'needs-model' | 'enabled' | 'degraded';
  detail?: string;
  engineReady: boolean;
  ftsAvailable: boolean;
  providerRef: string | null;
  modelRef: string | null;
}

const LAYERED_RECALL_BUDGET = {
  l1: { limit: 5, itemChars: 240, totalChars: 1_200 },
  l2: { limit: 3, itemChars: 320, totalChars: 960 },
  l3: { limit: 1, itemChars: 1_200, totalChars: 1_200 },
} as const;
const PROFILE_RECALL_TIMEOUT_MS = 2_000;

/** Secret reference that holds the memory engine Bearer gate. */
export const MEMORY_KERNEL_AUTH_SECRET_REFERENCE = 'file-secret:anyfusion/internal/memory-kernel-auth-token' as const;
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
export const MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE = 'file-secret:anyfusion/internal/memory-user-key' as const;

export class MemoryRuntime {
  private scheduler: MemoryFlushScheduler | null = null;
  /** Last extraction failure; published as a degraded reason, never a blocker. */
  private flushError: string | null = null;
  private usageDrainer: (() => Promise<void>) | null = null;
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
      options.secretStore, MEMORY_INSTALLATION_USER_KEY_SECRET_REFERENCE, undefined, 'user key',
    );
    const kernelAuthToken = await resolveControlAuthToken(options);

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
        preflight: { host: '127.0.0.1', port: policy.port },
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
      recallRepo,
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
    const service = this.service;
    const drainer = options.usageObserver
      ? createMemoryUsageDrainer({
        accountId: options.accountId,
        drainUsage: () => service.drainEngineUsage(),
        ...(options.queryLifecycle ? { queryLifecycle: options.queryLifecycle } : {}),
        usageObserver: options.usageObserver,
        ...(options.resolveUsagePayer ? { resolveUsagePayer: options.resolveUsagePayer } : {}),
        configurationRevision: options.configurationRevision ?? 'unknown',
        providerRef: this.policy.providerRef,
        modelRef: this.policy.modelRef,
        ...(options.now ? { now: () => new Date(options.now!()) } : {}),
      })
      : null;
    this.usageDrainer = drainer ? async () => { await drainer.drain(); } : null;
    this.scheduler = new MemoryFlushScheduler({
      service,
      accountId: options.accountId,
      intervalMs: 60_000,
      ...(options.now ? { now: options.now } : {}),
      ...(this.usageDrainer ? { onMaintenance: this.usageDrainer } : {}),
      logger: this.logger,
      // An unusable extraction model (quota, bad model id) is a warning: memory
      // degrades with a reason while planning and execution continue normally.
      onTickResult: error => this.recordFlushOutcome(options.db, error),
    });
    this.scheduler.start();
  }

  /** Persists the extraction outcome so `/api/memory/status` can warn. */
  private recordFlushOutcome(db: Database.Database, error: string | null): void {
    const next = error ? `memory_extraction_failed: ${error.slice(0, 200)}` : null;
    if (next === this.flushError) return;
    this.flushError = next;
    this.recordRuntimeState(db);
  }

  get status(): MemoryRuntimeStatus {
    const engineReady = this.sidecar?.status.healthy ?? Boolean(this.service);
    const detail = this.flushError ?? this.detail;
    const degradedByFlush = this.flushError !== null && this.service !== null;
    return {
      mode: degradedByFlush
        ? 'degraded'
        : this.service ? 'enabled' : this.policy.mode === 'enabled' ? 'degraded' : this.policy.mode,
      ...(detail ? { detail } : {}),
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
      const reason = this.detail ?? this.status.mode;
      this.recall.replaceLayered({
        accountId: input.accountId,
        conversationId: input.conversationId,
        recall: {
          l1: { status: 'degraded', reason, durationMs: 0, candidateCount: 0, items: [] },
          l2: { status: 'degraded', reason, durationMs: 0, candidateCount: 0, items: [] },
          l3: { status: 'degraded', reason, durationMs: 0, candidateCount: 0, items: [] },
        },
      });
      this.recall.recordDegraded({
        accountId: input.accountId,
        conversationId: input.conversationId,
        degraded: true,
        reason,
      });
      return;
    }
    try {
      const [l1Result, l2Result, l3Result] = await Promise.allSettled([
        measureRecall(() => this.service!.search({ accountId: input.accountId, query: input.query, limit: LAYERED_RECALL_BUDGET.l1.limit })),
        measureRecall(() => withTimeout(
          this.service!.searchScenarios({ accountId: input.accountId, query: input.query, limit: LAYERED_RECALL_BUDGET.l2.limit }),
          PROFILE_RECALL_TIMEOUT_MS,
          'memory_l2_timeout',
        )),
        measureRecall(() => withTimeout(
          this.service!.readPersona({ accountId: input.accountId }),
          PROFILE_RECALL_TIMEOUT_MS,
          'memory_l3_timeout',
        )),
      ]);
      const recall: LayeredMemoryRecall = {
        l1: { status: 'empty', items: [] },
        l2: { status: 'empty', items: [] },
        l3: { status: 'empty', items: [] },
      };
      if (l1Result.status === 'fulfilled' && l1Result.value.ok && !l1Result.value.value.degraded) {
        const items = bindL1Items(this.service, l1Result.value.value.items, input, LAYERED_RECALL_BUDGET.l1.itemChars);
        recall.l1 = {
          status: items.length ? 'available' : 'empty',
          durationMs: l1Result.value.durationMs,
          candidateCount: items.length,
          items,
        };
      } else {
        recall.l1 = {
          status: 'degraded',
          reason: l1Result.status === 'rejected' ? String(l1Result.reason)
            : !l1Result.value.ok ? String(l1Result.value.error) : l1Result.value.value.degradedReason,
          durationMs: l1Result.status === 'fulfilled' ? l1Result.value.durationMs : 0,
          candidateCount: 0,
          items: [],
        };
      }
      if (l2Result.status === 'fulfilled' && l2Result.value.ok && !l2Result.value.value.degraded) {
        const items = l2Result.value.value.items.flatMap(item => {
          const binding = this.service!.bind({
            accountId: input.accountId, tdaiMemoryId: item.id, layer: 'l2',
            workspaceId: input.workspaceId ?? null, revision: item.revision, title: item.title,
          });
          if (!binding.enabled) return [];
          return [{
            memoryId: binding.memoryId, layer: 'l2' as const, title: item.title,
            preview: truncateCodePoints(item.preview, LAYERED_RECALL_BUDGET.l2.itemChars),
            revision: item.revision, score: item.score, updatedAt: item.updatedAt, source: 'profile' as const,
          }];
        });
        recall.l2 = {
          status: items.length ? 'available' : 'empty',
          durationMs: l2Result.value.durationMs,
          candidateCount: items.length,
          items: items satisfies MemoryRecallItem[],
        };
      } else {
        recall.l2 = {
          status: 'degraded',
          reason: l2Result.status === 'rejected' ? String(l2Result.reason)
            : !l2Result.value.ok ? String(l2Result.value.error) : l2Result.value.value.degradedReason,
          durationMs: l2Result.status === 'fulfilled' ? l2Result.value.durationMs : 0,
          candidateCount: 0,
          items: [],
        };
      }
      if (l3Result.status === 'fulfilled' && l3Result.value.ok && l3Result.value.value.content && l3Result.value.value.id) {
        const binding = this.service.bind({
          accountId: input.accountId, tdaiMemoryId: l3Result.value.value.id, layer: 'l3',
          workspaceId: input.workspaceId ?? null, content: l3Result.value.value.content,
          revision: l3Result.value.value.revision, title: 'User persona', source: 'profile',
        });
        const items = binding.enabled ? [{
          memoryId: binding.memoryId, layer: 'l3' as const, title: 'User persona',
          preview: truncateCodePoints(l3Result.value.value.content, LAYERED_RECALL_BUDGET.l3.itemChars),
          revision: l3Result.value.value.revision ?? '', score: 1,
          updatedAt: l3Result.value.value.updatedAt, source: 'profile' as const,
        }] : [];
        recall.l3 = {
          status: items.length ? 'available' : 'empty',
          durationMs: l3Result.value.durationMs,
          candidateCount: items.length,
          items,
        };
      } else if (l3Result.status === 'rejected' || !l3Result.value.ok) {
        recall.l3 = {
          status: 'degraded',
          reason: l3Result.status === 'rejected' ? String(l3Result.reason)
            : l3Result.value.ok ? 'memory_persona_read_failed' : String(l3Result.value.error),
          durationMs: l3Result.status === 'fulfilled' ? l3Result.value.durationMs : 0,
          candidateCount: 0,
          items: [],
        };
      } else {
        recall.l3 = { status: 'empty', durationMs: l3Result.value.durationMs, candidateCount: 0, items: [] };
      }
      this.recall.replaceLayered({ accountId: input.accountId, conversationId: input.conversationId, recall });
      const allDegraded = [recall.l1, recall.l2, recall.l3].every(layer => layer.status === 'degraded');
      this.recall.recordDegraded({
        accountId: input.accountId, conversationId: input.conversationId, degraded: allDegraded,
        ...(allDegraded ? { reason: 'memory_all_layers_unavailable' } : {}),
      });
    } catch (error) {
      this.logger(`memory recall refresh failed: ${(error as Error).message}`);
      try {
        this.recall.replaceLayered({
          accountId: input.accountId,
          conversationId: input.conversationId,
          recall: {
            l1: { status: 'degraded', reason: (error as Error).message, durationMs: 0, candidateCount: 0, items: [] },
            l2: { status: 'degraded', reason: (error as Error).message, durationMs: 0, candidateCount: 0, items: [] },
            l3: { status: 'degraded', reason: (error as Error).message, durationMs: 0, candidateCount: 0, items: [] },
          },
        });
      } catch {
        // A storage failure must not escape the best-effort recall path. Clear
        // is retained as the last-resort cleanup for partially written rows.
        try {
          this.recall.clear(input.accountId, input.conversationId);
        } catch {
          // The database itself is unavailable; there is no safe projection to
          // repair in this process.
        }
      }
      try {
        this.recall.recordDegraded({
          accountId: input.accountId,
          conversationId: input.conversationId,
          degraded: true,
          reason: (error as Error).message,
        });
      } catch {
        // Keep Planner preparation independent from memory projection storage.
      }
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
      // Final usage drain before the engine stops, so a call that just finished
      // is not lost with the sidecar process.
      await this.usageDrainer?.().catch(error => {
        this.logger(`memory usage drain failed: ${(error as Error).message}`);
      });
      await this.drain();
    } catch (error) {
      this.logger(`memory shutdown drain failed: ${(error as Error).message}`);
    }
    this.scheduler?.stop();
    this.scheduler = null;
    await this.stopSidecar();
  }
}

function bindL1Items(
  service: MemoryService,
  items: readonly MemorySearchCandidate[],
  input: { accountId: string; workspaceId?: string | null },
  maxChars: number,
): MemoryRecallItem[] {
  return items.slice(0, LAYERED_RECALL_BUDGET.l1.limit).map(item => {
    const binding = service.bind({
      accountId: input.accountId, tdaiMemoryId: item.id, layer: 'l1',
      workspaceId: input.workspaceId ?? null, content: item.content,
      revision: item.revision, title: item.type,
    });
    return {
      memoryId: binding.memoryId, layer: 'l1' as const, title: item.type,
      preview: truncateCodePoints(item.content, maxChars), revision: item.revision ?? '',
      score: item.score, updatedAt: item.updatedAt, source: binding.source,
    };
  }).filter(item => service.bindingFor({ accountId: input.accountId, memoryId: item.memoryId }) !== null);
}

function truncateCodePoints(value: string, maxChars: number): string {
  return [...value].slice(0, maxChars).join('');
}

type MeasuredRecall<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; error: unknown; durationMs: number };

async function measureRecall<T>(operation: () => Promise<T>): Promise<MeasuredRecall<T>> {
  const startedAt = Date.now();
  try {
    return {
      ok: true,
      value: await operation(),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      error,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Apply `memory.sidecar.dataDir` when configured, else the account default. */
export function resolveDataDir(policy: MemoryRuntimePolicy, fallback: string): string {
  return policy.dataDir && policy.dataDir.trim() ? policy.dataDir : fallback;
}

async function readSecret(
  store: SecretStore,
  reference: string,
  logger: ((message: string) => void) | undefined,
  label: string,
): Promise<string> {
  try {
    return await store.get(reference as SecretReference);
  } catch (error) {
    logger?.(`memory ${label} unavailable: ${(error as Error).message}`);
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
async function resolveControlAuthToken(options: MemoryRuntimeOptions): Promise<string> {
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
