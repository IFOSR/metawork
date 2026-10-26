/**
 * MemoryRuntimeController — owns the current MemoryRuntime across configuration
 * activations.
 *
 * Design §7 makes memory a revisioned-configuration setting: the user saves the
 * switch and the extraction model in the settings transaction and expects them
 * to take effect. The runtime therefore has to be replaceable without
 * restarting the Server, and every consumer (evidence delivery, Planner recall,
 * the management view) has to keep seeing the current instance.
 *
 * A rebuild only happens when the `memory` section actually changed, so an
 * unrelated settings save never restarts the engine.
 */

import type Database from 'better-sqlite3';
import type { SecretStore } from '../configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import {
  MemoryRuntime,
  type MemoryRuntimeOptions,
  type MemoryRuntimeStatus,
  type MemorySidecarCommand,
} from './memory-runtime.js';

export interface MemoryRuntimeControllerOptions {
  accountId: string;
  db: Database.Database;
  secretStore: SecretStore;
  dataDir: string;
  sidecarCommand?: MemorySidecarCommand | null;
  sidecarUnavailableReason?: string;
  sidecarReadyTimeoutMs?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface MemoryConfigurationApplyResult {
  rebuilt: boolean;
  status: MemoryRuntimeStatus;
  /** Deposited turns flushed by the shutdown drain before the rebuild. */
  flushed: number;
  error?: string;
}

/** Canonical form of the memory section, used to detect a real change. */
function memorySectionKey(configuration: AnyFusionConfigurationV2): string {
  return JSON.stringify(configuration.memory ?? null);
}

export class MemoryRuntimeController {
  private current: MemoryRuntime;
  /** The configuration the current runtime was built from. */
  private appliedConfiguration: AnyFusionConfigurationV2;
  private readonly logger: (message: string) => void;

  private constructor(
    private readonly options: MemoryRuntimeControllerOptions,
    runtime: MemoryRuntime,
    configuration: AnyFusionConfigurationV2,
  ) {
    this.current = runtime;
    this.appliedConfiguration = configuration;
    this.logger = options.logger ?? (() => undefined);
  }

  static async create(input: {
    options: MemoryRuntimeControllerOptions;
    configuration: AnyFusionConfigurationV2;
  }): Promise<MemoryRuntimeController> {
    const runtime = await MemoryRuntime.create(buildOptions(input.options, input.configuration));
    return new MemoryRuntimeController(input.options, runtime, input.configuration);
  }

  /** The live runtime. Never null: a disabled or degraded runtime is still a runtime. */
  get runtime(): MemoryRuntime {
    return this.current;
  }

  get status(): MemoryRuntimeStatus {
    return this.current.status;
  }

  /**
   * Apply a newly activated configuration.
   *
   * Returns `rebuilt: false` when the memory section is unchanged, so the
   * common case (saving an unrelated setting) does not touch the engine.
   */
  async applyConfiguration(
    configuration: AnyFusionConfigurationV2,
  ): Promise<MemoryConfigurationApplyResult> {
    if (memorySectionKey(configuration) === memorySectionKey(this.appliedConfiguration)) {
      return { rebuilt: false, status: this.current.status, flushed: 0 };
    }
    const previous = this.current;
    // Drain first: the pending turns belong to the old engine scope, and losing
    // them on a configuration change would be silent data loss.
    let flushed = 0;
    try {
      const drained = await previous.drain();
      flushed = drained.flushed;
    } catch (error) {
      this.logger(`memory drain before rebuild failed: ${(error as Error).message}`);
    }
    await previous.stop();
    let error: string | undefined;
    let next: MemoryRuntime;
    try {
      next = await MemoryRuntime.create(buildOptions(this.options, configuration));
    } catch (failure) {
      // Keeping the previous (stopped) runtime would leave the seam half-open;
      // a degraded runtime is the honest state.
      error = (failure as Error).message;
      this.logger(`memory runtime rebuild failed: ${error}`);
      next = await MemoryRuntime.create(buildOptions(this.options, {
        ...configuration,
        memory: { ...configuration.memory, enabled: false },
      } as AnyFusionConfigurationV2));
    }
    this.current = next;
    this.appliedConfiguration = configuration;
    return {
      rebuilt: true,
      status: next.status,
      flushed,
      ...(error ? { error } : {}),
    };
  }

  /** Stop the capability, depositing anything still pending (design §5.2). */
  async stop(): Promise<void> {
    await this.current.stop();
  }
}

function buildOptions(
  options: MemoryRuntimeControllerOptions,
  configuration: AnyFusionConfigurationV2,
): MemoryRuntimeOptions {
  return {
    configuration,
    accountId: options.accountId,
    db: options.db,
    secretStore: options.secretStore,
    dataDir: options.dataDir,
    sidecarCommand: options.sidecarCommand ?? null,
    ...(options.sidecarUnavailableReason
      ? { sidecarUnavailableReason: options.sidecarUnavailableReason }
      : {}),
    ...(options.sidecarReadyTimeoutMs
      ? { sidecarReadyTimeoutMs: options.sidecarReadyTimeoutMs }
      : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

/** Describe a runtime status for the startup and activation logs. */
export function describeMemoryStatus(status: MemoryRuntimeStatus): string {
  const model = status.mode === 'enabled' && status.modelRef ? ` (model ${status.modelRef})` : '';
  const detail = status.detail ? `: ${status.detail}` : '';
  return `${status.mode}${detail}${model}`;
}
