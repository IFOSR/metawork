import {
  buildKernelConfigurationView,
  buildPlannerConfigurationView,
  buildRuntimeConfigurationView,
} from './projections.js';
import {
  classifyConfigurationDiff,
  type ConfigurationDiffClassification,
} from './configuration-diff.js';
import type { ConfigurationService } from './configuration-service.js';
import type {
  AnyFusionConfigurationV2,
  ConfigurationSnapshot,
  KernelConfigurationView,
  PlannerConfigurationView,
  RuntimeConfigurationView,
} from './types.js';
import {
  ConfigurationActivationBlockedError,
  ConfigurationActivationGate,
  type ConfigurationActivationStatusSnapshot,
} from './configuration-activation-gate.js';

export type ConfigurationRuntimeEvent =
  | { type: 'configuration_runtime_state'; state: ConfigurationRuntimeState }
  | {
    type: 'configuration_activated';
    revisionId: string;
    previousRevisionId: string;
    classification: ConfigurationDiffClassification['classification'];
  };

export interface ConfigurationRuntimeState extends ConfigurationActivationStatusSnapshot {
  activeRevisionId: string;
  runtimeRevisionId: string;
  restartRequired: boolean;
}

export type ConfigurationRuntimeActivationResult =
  | {
    ok: true;
    snapshot: ConfigurationSnapshot;
    classification: 'hot' | 'none';
  }
  | {
    ok: false;
    code: 'revision_conflict'
      | 'restart_required'
      | 'invalid_configuration'
      | 'probe_failed'
      | 'runtime_busy'
      | 'activation_failed';
    activeRevisionId: string;
    restartPaths?: string[];
    issues?: string[];
  };

export interface ConfigurationRuntimeCoordinatorDeps {
  service: Pick<
    ConfigurationService,
    | 'getActiveSnapshot'
    | 'createDraft'
    | 'validateDraft'
    | 'compileDraft'
    | 'probeDraft'
    | 'activateDraft'
  > & {
    activateDraft: (
      revisionId: string,
      expectedRevisionId: string | null,
      reason?: 'activation' | 'rollback',
      options?: { allowNestedActivation?: boolean },
    ) => Promise<{
      ok: true;
      snapshot: ConfigurationSnapshot;
    } | {
      ok: false;
      code: 'revision_conflict';
      activeRevisionId: string | null;
    }>;
    restoreActiveSnapshot?: (
      revisionId: string,
      expectedActiveRevisionId: string | null,
    ) => Promise<ConfigurationSnapshot>;
  };
  gate: ConfigurationActivationGate;
  initialSnapshot: ConfigurationSnapshot;
  publish?: (event: ConfigurationRuntimeEvent) => void;
  onActivated?: (input: {
    snapshot: ConfigurationSnapshot;
    planner: PlannerConfigurationView;
    kernel: KernelConfigurationView;
    runtime: RuntimeConfigurationView;
  }) => void | Promise<void>;
  onActivationFailed?: (input: {
    snapshot: ConfigurationSnapshot;
    planner: PlannerConfigurationView;
    kernel: KernelConfigurationView;
    runtime: RuntimeConfigurationView;
  }) => void | Promise<void>;
  /**
   * Registers the candidate revision in the account database before the active
   * pointer can expose it to revision-pinned Planner/Kernel consumers.
   */
  registerRevision?: (
    snapshot: ConfigurationSnapshot,
    reason: 'activation' | 'rollback',
  ) => void | Promise<void>;
  prepareConfig?: (input: {
    config: unknown;
    secrets: Record<string, string>;
  }) => Promise<unknown> | unknown;
  /**
   * Applies candidate secrets only for the duration of activation and returns
   * a compensating action. This lets the probe validate the exact candidate
   * without leaving credentials behind on validation/probe/cutover failure.
   */
  stageSecrets?: (
    secrets: Record<string, string>,
  ) => Promise<(() => Promise<void>) | undefined> | (() => Promise<void>) | undefined;
}

export class ConfigurationRuntimeCoordinator {
  private readonly listeners = new Set<(event: ConfigurationRuntimeEvent) => void>();
  private activeSnapshot: ConfigurationSnapshot;
  private plannerView: PlannerConfigurationView;
  private kernelView: KernelConfigurationView;
  private runtimeView: RuntimeConfigurationView;

  constructor(private readonly deps: ConfigurationRuntimeCoordinatorDeps) {
    this.activeSnapshot = deps.initialSnapshot;
    this.plannerView = buildPlannerConfigurationView(deps.initialSnapshot);
    this.kernelView = buildKernelConfigurationView(deps.initialSnapshot);
    this.runtimeView = buildRuntimeConfigurationView(deps.initialSnapshot);
  }

  getSnapshot(): ConfigurationSnapshot {
    return this.activeSnapshot;
  }

  getPlannerView(): PlannerConfigurationView {
    return this.plannerView;
  }

  getKernelView(): KernelConfigurationView {
    return this.kernelView;
  }

  getRuntimeView(): RuntimeConfigurationView {
    return this.runtimeView;
  }

  getState(): ConfigurationRuntimeState {
    const gate = this.deps.gate.getStatus();
    return {
      ...gate,
      activeRevisionId: this.activeSnapshot.revisionId,
      runtimeRevisionId: this.activeSnapshot.revisionId,
      restartRequired: false,
    };
  }

  subscribe(listener: (event: ConfigurationRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<ConfigurationRuntimeState> {
    const snapshot = await this.deps.service.getActiveSnapshot();
    this.replaceLiveSnapshot(snapshot);
    return this.getState();
  }

  async activate(input: {
    config: unknown;
    expectedRevisionId: string;
    reason?: 'activation' | 'rollback';
    secrets?: Record<string, string>;
  }): Promise<ConfigurationRuntimeActivationResult> {
    try {
      return await this.deps.gate.withActivation(
        () => this.activateWithinGate(input),
      );
    } catch (error) {
      if (error instanceof ConfigurationActivationBlockedError) {
        return {
          ok: false,
          code: 'runtime_busy',
          activeRevisionId: this.activeSnapshot.revisionId,
          issues: error.status.blockingReasons.map(reason => reason.message),
        };
      }
      throw error;
    }
  }

  private async activateWithinGate(input: {
    config: unknown;
    expectedRevisionId: string;
    reason?: 'activation' | 'rollback';
    secrets?: Record<string, string>;
  }): Promise<ConfigurationRuntimeActivationResult> {
    const current = await this.deps.service.getActiveSnapshot();
    if (current.revisionId !== input.expectedRevisionId) {
      return {
        ok: false,
        code: 'revision_conflict',
        activeRevisionId: current.revisionId,
      };
    }
    const initialDraft = this.deps.service.createDraft(input.config, input.expectedRevisionId);
    const initialValidation = this.deps.service.validateDraft(initialDraft.revisionId);
    if (!initialValidation.ok) {
      return {
        ok: false,
        code: 'invalid_configuration',
        activeRevisionId: current.revisionId,
        issues: initialValidation.issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`),
      };
    }
    // Preparation must remain side-effect free. Secret persistence, when
    // needed, happens only after the candidate has passed validation.
    const preparedConfig = input.secrets && Object.keys(input.secrets).length > 0
      ? await this.deps.prepareConfig?.({
          config: input.config,
          secrets: input.secrets,
        }) ?? input.config
      : input.config;
    const draft = preparedConfig === input.config
      ? initialDraft
      : this.deps.service.createDraft(preparedConfig, input.expectedRevisionId);
    const validation = draft === initialDraft
      ? initialValidation
      : this.deps.service.validateDraft(draft.revisionId);
    if (!validation.ok) {
      return {
        ok: false,
        code: 'invalid_configuration',
        activeRevisionId: current.revisionId,
        issues: validation.issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`),
      };
    }
    const classification = classifyConfigurationDiff(current.config, validation.config);
    if (classification.classification === 'restart_required') {
      return {
        ok: false,
        code: 'restart_required',
        activeRevisionId: current.revisionId,
        restartPaths: classification.restartPaths,
      };
    }
    let rollbackSecrets: (() => Promise<void>) | undefined;
    const rollbackCandidate = async (): Promise<void> => {
      await rollbackSecrets?.();
      rollbackSecrets = undefined;
    };
    let compiled: ReturnType<ConfigurationRuntimeCoordinatorDeps['service']['compileDraft']>;
    try {
      rollbackSecrets = await this.deps.stageSecrets?.(input.secrets ?? {});
      compiled = this.deps.service.compileDraft(draft.revisionId);
      const probe = await this.deps.service.probeDraft(draft.revisionId);
      if (!probe.ok) {
        await rollbackCandidate();
        return {
          ok: false,
          code: 'probe_failed',
          activeRevisionId: current.revisionId,
          issues: probe.issues,
        };
      }
    } catch (error) {
      await rollbackCandidate();
      throw error;
    }
    try {
      await this.deps.registerRevision?.({
        revisionId: draft.revisionId,
        contentHash: compiled.contentHash,
        config: validation.config,
      }, input.reason ?? 'activation');
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await rollbackCandidate();
      return {
        ok: false,
        code: 'activation_failed',
        activeRevisionId: current.revisionId,
        issues: [failure],
      };
    }
    let result: Awaited<ReturnType<ConfigurationRuntimeCoordinatorDeps['service']['activateDraft']>>;
    try {
      // ConfigurationService owns the same gate for the final optimistic
      // concurrency check. Wrapping it here would make the service observe
      // its own activation_in_progress state and reject every activation.
      result = await this.deps.service.activateDraft(
        draft.revisionId,
        input.expectedRevisionId,
        input.reason ?? 'activation',
        { allowNestedActivation: true },
      );
    } catch (error) {
      if (error instanceof ConfigurationActivationBlockedError) {
        await rollbackCandidate();
        return {
          ok: false,
          code: 'runtime_busy',
          activeRevisionId: current.revisionId,
          issues: error.status.blockingReasons.map(reason => reason.message),
        };
      }
      if (this.deps.service.restoreActiveSnapshot) {
        await this.deps.service.restoreActiveSnapshot(
          current.revisionId,
          draft.revisionId,
        ).catch(() => undefined);
      }
      await rollbackCandidate();
      throw error;
    }
    if (!result.ok) {
      await rollbackCandidate();
      return {
        ok: false,
        code: 'revision_conflict',
        activeRevisionId: result.activeRevisionId ?? current.revisionId,
      };
    }
    this.replaceLiveSnapshot(result.snapshot);
    try {
      await this.deps.onActivated?.({
        snapshot: this.activeSnapshot,
        planner: this.plannerView,
        kernel: this.kernelView,
        runtime: this.runtimeView,
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const rollbackFailures: string[] = [];
      if (this.deps.service.restoreActiveSnapshot) {
        try {
          await this.deps.service.restoreActiveSnapshot(
            current.revisionId,
            result.snapshot.revisionId,
          );
        } catch (rollbackError) {
          rollbackFailures.push(
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          );
        }
      }
      this.replaceLiveSnapshot(current);
      try {
        await rollbackCandidate();
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      try {
        await this.deps.onActivationFailed?.({
          snapshot: current,
          planner: this.plannerView,
          kernel: this.kernelView,
          runtime: this.runtimeView,
        });
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      if (rollbackFailures.length > 0) {
        throw new Error(
          `configuration activation failed and rollback failed: ${failure}; `
          + rollbackFailures.join('; '),
        );
      }
      return {
        ok: false,
        code: 'activation_failed',
        activeRevisionId: current.revisionId,
        issues: [failure],
      };
    }
    this.emit({
      type: 'configuration_runtime_state',
      state: this.getState(),
    });
    this.emit({
      type: 'configuration_activated',
      revisionId: result.snapshot.revisionId,
      previousRevisionId: current.revisionId,
      classification: classification.classification,
    });
    return {
      ok: true,
      snapshot: result.snapshot,
      classification: classification.classification === 'none' ? 'none' : 'hot',
    };
  }

  private replaceLiveSnapshot(snapshot: ConfigurationSnapshot): void {
    this.activeSnapshot = snapshot;
    this.plannerView = buildPlannerConfigurationView(snapshot);
    this.kernelView = buildKernelConfigurationView(snapshot);
    this.runtimeView = buildRuntimeConfigurationView(snapshot);
    // Consumers are notified by activate() after the live views are replaced.
  }

  private emit(event: ConfigurationRuntimeEvent): void {
    this.deps.publish?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

export function configurationRuntimeState(
  coordinator: ConfigurationRuntimeCoordinator,
): ConfigurationRuntimeState {
  return coordinator.getState();
}

export type { AnyFusionConfigurationV2 };
