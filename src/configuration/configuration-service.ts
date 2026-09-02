import { createHash, randomUUID } from 'node:crypto';
import { dump } from 'js-yaml';
import {
  buildKernelConfigurationView,
  buildPlannerConfigurationView,
  buildRuntimeConfigurationView,
} from './projections.js';
import {
  FileConfigurationRepository,
  RevisionConflictError,
} from './file-configuration-repository.js';
import {
  validateConfigurationCandidate,
  type ConfigurationValidationIssue,
  type ConfigurationValidationResult,
} from './configuration-validator.js';
import type {
  AnyFusionConfigurationV2,
  ConfigurationServicePort,
  ConfigurationSnapshot,
  ExecutorManualUserProfile,
  KernelConfigurationView,
  PlannerConfigurationView,
  PlannerExecutorCapabilityManual,
  RuntimePrivateConfigurationBinding,
} from './types.js';
import { resolveRuntimePrivateConfigurationBinding } from './runtime-private-binding-resolver.js';
import type { SecretStore } from './secret-store.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { AgentRuntimeRenderer } from './agent-runtime-renderer.js';
import type { ConfigurationActivationGate } from './configuration-activation-gate.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import {
  fingerprintExecutorManualSemantics,
  fingerprintExecutorManualSourceText,
} from './executor-manual-source.js';

export interface CompiledConfigurationRevision {
  contentHash: string;
  files: Record<string, string | Buffer>;
}

export interface ConfigurationProbeResult {
  ok: boolean;
  issues?: string[];
}

export interface ConfigurationRevisionAuditPort {
  recordActivation(input: {
    revisionId: string;
    previousRevisionId: string | null;
    contentHash: string;
    reason: 'activation' | 'rollback';
  }): Promise<void>;
}

interface ConfigurationDraft {
  revisionId: string;
  baseRevisionId: string | null;
  input: unknown;
  config?: AnyFusionConfigurationV2;
  validationIssues?: ConfigurationValidationIssue[];
  compiled?: CompiledConfigurationRevision;
  probed: boolean;
}

export interface ConfigurationServiceDependencies {
  repository: FileConfigurationRepository;
  secretStore?: SecretStore;
  renderer?: AgentRuntimeRenderer;
  createRevisionId?: () => string;
  probe?: (
    snapshot: ConfigurationSnapshot,
    compiled: CompiledConfigurationRevision,
  ) => Promise<ConfigurationProbeResult>;
  audit?: ConfigurationRevisionAuditPort;
  activationGate?: ConfigurationActivationGate;
}

export type ActivateDraftResult =
  | { ok: true; snapshot: ConfigurationSnapshot }
  | {
      ok: false;
      code: 'revision_conflict';
      activeRevisionId: string | null;
    };

export interface ActivateDraftOptions {
  /** Used only when an outer AccountRuntime coordinator owns the gate. */
  allowNestedActivation?: boolean;
}

export interface ExecutorManualSemanticEdit {
  agentClassRef: string;
  userProfile: ExecutorManualUserProfile;
}

/**
 * Normalize a permissive Planner/tool payload into the canonical assertion
 * shape before schema validation. Some models attach routing metadata to a
 * strength or task assertion; preserve that meaning and materialize a
 * separate capability-policy assertion instead of discarding the route intent.
 */
function normalizeExecutorManualProfile(
  profile: ExecutorManualUserProfile,
): ExecutorManualUserProfile {
  const assertions: ExecutorManualUserProfile['assertions'] = [];
  for (const assertion of profile.assertions) {
    if (assertion.topic === 'capability-policy') {
      assertions.push(structuredClone(assertion));
      continue;
    }

    const {
      routingCapability,
      disposition,
      ...semanticAssertion
    } = assertion;
    assertions.push(structuredClone(semanticAssertion));
    if (routingCapability && disposition) {
      assertions.push({
        ...structuredClone(semanticAssertion),
        topic: 'capability-policy',
        routingCapability,
        disposition,
      });
    }
  }
  return {
    ...structuredClone(profile),
    assertions,
  };
}

export function validateExecutorManualSourceText(sourceText: string): void {
  if (sourceText.length > 8_000 || Buffer.byteLength(sourceText, 'utf8') > 8_000) {
    throw new Error('Executor manual sourceText exceeds 8000 UTF-8 bytes');
  }
  if (redactSensitiveText(sourceText) !== sourceText) {
    throw new Error('Executor manual guidance must not contain credential-like content');
  }
}

export class ConfigurationService implements ConfigurationServicePort {
  private readonly drafts = new Map<string, ConfigurationDraft>();
  private readonly manualSemanticReceipts = new Map<string, {
    agentClassRef: string;
    baseRevisionId: string | null;
    semanticFingerprint: string;
  }>();
  private readonly createRevisionId: () => string;
  private readonly probe: NonNullable<ConfigurationServiceDependencies['probe']>;

  constructor(private readonly dependencies: ConfigurationServiceDependencies) {
    this.createRevisionId = dependencies.createRevisionId
      ?? (() => `revision-${randomUUID()}`);
    this.probe = dependencies.probe ?? (async () => ({
      ok: false,
      issues: ['configuration probe is not configured'],
    }));
  }

  async initialize(): Promise<void> {
    await this.dependencies.repository.initialize();
    await this.dependencies.repository.recover();
  }

  createDraft(input: unknown, baseRevisionId: string | null): {
    revisionId: string;
    baseRevisionId: string | null;
  } {
    const revisionId = this.createRevisionId();
    if (this.drafts.has(revisionId)) {
      throw new Error(`duplicate configuration draft revision ID: ${revisionId}`);
    }
    this.drafts.set(revisionId, {
      revisionId,
      baseRevisionId,
      input: structuredClone(input),
      probed: false,
    });
    return { revisionId, baseRevisionId };
  }

  validateDraft(revisionId: string): ConfigurationValidationResult {
    const draft = this.requireDraft(revisionId);
    const result = validateConfigurationCandidate(draft.input);
    if (result.ok) {
      draft.config = result.config;
      draft.validationIssues = undefined;
    } else {
      draft.config = undefined;
      draft.compiled = undefined;
      draft.probed = false;
      draft.validationIssues = result.issues;
    }
    return result;
  }

  compileDraft(revisionId: string): CompiledConfigurationRevision {
    const draft = this.requireDraft(revisionId);
    if (!draft.config) throw new Error('configuration draft must be validated before compile');
    const compiled = compileConfigurationRevision(revisionId, draft.config);
    draft.compiled = compiled;
    draft.probed = false;
    return compiled;
  }

  /**
   * Applies optional model-normalized Executor guidance to a mutable draft.
   * ConfigurationService remains the write and validation authority.
   */
  applyExecutorManualProposal(
    revisionId: string,
    edit: ExecutorManualSemanticEdit,
  ): void {
    const draft = this.requireDraft(revisionId);
    const userProfile = normalizeExecutorManualProfile(edit.userProfile);
    const input = asRecord(draft.input);
    const agentClasses = asRecord(input.agentClasses);
    const agentClass = asRecord(agentClasses[edit.agentClassRef]);
    if (agentClass.kind !== 'executor') {
      throw new Error(`Executor manual edits require an Executor AgentClass: ${edit.agentClassRef}`);
    }
    validateExecutorManualSourceText(userProfile.sourceText);
    if (
      userProfile.sourceText.trim().length === 0
      && userProfile.assertions.length > 0
    ) {
      throw new Error('Executor manual assertions require non-empty sourceText');
    }
    for (const assertion of userProfile.assertions) {
      if (assertion.text.length > 500
        || Buffer.byteLength(assertion.text, 'utf8') > 2_000) {
        throw new Error('Executor manual assertion exceeds 500 characters or 2000 UTF-8 bytes');
      }
      if (redactSensitiveText(assertion.text) !== assertion.text) {
        throw new Error('Executor manual assertions must not contain credential-like content');
      }
      if (assertion.topic === 'capability-policy'
        && (!assertion.routingCapability || !assertion.disposition)) {
        throw new Error(
          'Executor capability-policy assertions require routingCapability and disposition',
        );
      }
    }
    const semanticReceipt = (
      userProfile.assertions.length > 0
      || userProfile.sourceText.trim().length === 0
    )
      ? `manual_${randomUUID()}`
      : undefined;
    if (semanticReceipt) {
      if (this.manualSemanticReceipts.size >= 256) {
        const oldestReceipt = this.manualSemanticReceipts.keys().next().value;
        if (oldestReceipt) this.manualSemanticReceipts.delete(oldestReceipt);
      }
      this.manualSemanticReceipts.set(semanticReceipt, {
        agentClassRef: edit.agentClassRef,
        baseRevisionId: draft.baseRevisionId,
        semanticFingerprint: fingerprintExecutorManualSemantics(userProfile),
      });
    }
    draft.input = {
      ...input,
        agentClasses: {
        ...agentClasses,
        [edit.agentClassRef]: {
          ...agentClass,
          executorManual: {
            ...userProfile,
            ...(semanticReceipt
              ? {
                  assertionsSourceFingerprint:
                    fingerprintExecutorManualSourceText(userProfile.sourceText),
                  semanticReceipt,
                }
              : {
                  assertionsSourceFingerprint: undefined,
                  semanticReceipt: undefined,
                }),
          },
        },
      },
    };
    draft.config = undefined;
    draft.compiled = undefined;
    draft.validationIssues = undefined;
    draft.probed = false;
  }

  isExecutorManualSemanticReceiptValid(
    agentClassRef: string,
    baseRevisionId: string | null,
    profile: ExecutorManualUserProfile,
  ): boolean {
    const receipt = profile.semanticReceipt
      ? this.manualSemanticReceipts.get(profile.semanticReceipt)
      : undefined;
    return Boolean(
      profile.assertions.length > 0
      && profile.assertionsSourceFingerprint
      && profile.assertionsSourceFingerprint
        === fingerprintExecutorManualSourceText(profile.sourceText)
      && receipt
      && receipt.agentClassRef === agentClassRef
      && receipt.baseRevisionId === baseRevisionId
      && receipt.semanticFingerprint === fingerprintExecutorManualSemantics(profile),
    );
  }

  async probeDraft(revisionId: string): Promise<ConfigurationProbeResult> {
    const draft = this.requireDraft(revisionId);
    if (!draft.config || !draft.compiled) {
      throw new Error('configuration draft must be compiled before probe');
    }
    const result = await this.probe(
      snapshotFor(draft.revisionId, draft.compiled.contentHash, draft.config),
      draft.compiled,
    );
    draft.probed = result.ok;
    return result;
  }

  async activateDraft(
    revisionId: string,
    expectedRevisionId: string | null,
    reason: 'activation' | 'rollback' = 'activation',
    options: ActivateDraftOptions = {},
  ): Promise<ActivateDraftResult> {
    if (this.dependencies.activationGate) {
      return this.dependencies.activationGate.withActivation(
        () => this.activateDraftInternal(revisionId, expectedRevisionId, reason),
        { allowNested: options.allowNestedActivation },
      );
    }
    return this.activateDraftInternal(revisionId, expectedRevisionId, reason);
  }

  private async activateDraftInternal(
    revisionId: string,
    expectedRevisionId: string | null,
    reason: 'activation' | 'rollback',
  ): Promise<ActivateDraftResult> {
    const draft = this.requireDraft(revisionId);
    if (!draft.config || !draft.compiled) {
      throw new Error('configuration draft must be validated and compiled before activation');
    }
    if (!draft.probed) {
      throw new Error('configuration draft must be probed before activation');
    }
    if (reason === 'activation') {
      await this.assertManualSemanticChangesCompiled(draft);
    }

    const currentRevisionId = await this.activeRevisionId();
    if (currentRevisionId !== expectedRevisionId) {
      return {
        ok: false,
        code: 'revision_conflict',
        activeRevisionId: currentRevisionId,
      };
    }

    const candidateSnapshot = snapshotFor(
      draft.revisionId,
      draft.compiled.contentHash,
      draft.config,
    );
    if (this.dependencies.renderer) {
      await this.dependencies.renderer.render(candidateSnapshot, { activateCurrent: false });
    }

    await this.dependencies.repository.writeRevision({
      revisionId,
      contentHash: draft.compiled.contentHash,
      files: draft.compiled.files,
    });
    try {
      await this.dependencies.repository.activateRevision(
        revisionId,
        expectedRevisionId,
      );
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return {
          ok: false,
          code: 'revision_conflict',
          activeRevisionId: error.activeRevisionId,
        };
      }
      throw error;
    }

    const snapshot = await this.dependencies.repository.readSnapshot(revisionId);
    if (this.dependencies.renderer) {
      await this.dependencies.renderer.activateCurrent(snapshot.revisionId);
    }
    await this.dependencies.audit?.recordActivation({
      revisionId,
      previousRevisionId: expectedRevisionId,
      contentHash: snapshot.contentHash,
      reason,
    });
    for (const agentClass of Object.values(snapshot.config.agentClasses)) {
      const semanticReceipt = agentClass.executorManual?.semanticReceipt;
      if (semanticReceipt) this.manualSemanticReceipts.delete(semanticReceipt);
    }
    this.drafts.delete(revisionId);
    return { ok: true, snapshot };
  }

  private async assertManualSemanticChangesCompiled(
    draft: ConfigurationDraft,
  ): Promise<void> {
    if (!draft.config) return;
    const base = draft.baseRevisionId
      ? await this.dependencies.repository.readSnapshot(draft.baseRevisionId)
      : null;
    for (const [agentClassRef, agentClass] of Object.entries(draft.config.agentClasses)) {
      if (agentClass.kind !== 'executor') continue;
      const sourceText = agentClass.executorManual?.sourceText.trim() ?? '';
      const manual = agentClass.executorManual;
      const baseManual = base?.config.agentClasses[agentClassRef]?.executorManual;
      const semanticChanged = fingerprintExecutorManualSemantics({
        sourceText,
        assertions: manual?.assertions ?? [],
      }) !== fingerprintExecutorManualSemantics({
        sourceText: baseManual?.sourceText ?? '',
        assertions: baseManual?.assertions ?? [],
      });
      const receipt = manual?.semanticReceipt
        ? this.manualSemanticReceipts.get(manual.semanticReceipt)
        : undefined;
      const hasStructuredAssertions = (manual?.assertions.length ?? 0) > 0;
      if (
        semanticChanged
        && (
          (
            hasStructuredAssertions
            && (
              manual?.assertionsSourceFingerprint
                !== fingerprintExecutorManualSourceText(sourceText)
              || !receipt
              || receipt.agentClassRef !== agentClassRef
              || receipt.baseRevisionId !== draft.baseRevisionId
              || receipt.semanticFingerprint !== fingerprintExecutorManualSemantics(manual)
            )
          )
        )
      ) {
        throw new Error(
          `Executor capability guidance contains untrusted semantic assertions: ${agentClassRef}`,
        );
      }
    }
  }

  async rollback(
    targetRevisionId: string,
    expectedRevisionId: string,
  ): Promise<ActivateDraftResult> {
    const target = await this.getSnapshot(targetRevisionId);
    const draft = this.createDraft(target.config, expectedRevisionId);
    this.validateDraft(draft.revisionId);
    this.compileDraft(draft.revisionId);
    const probe = await this.probeDraft(draft.revisionId);
    if (!probe.ok) throw new Error('rollback configuration probe failed');
    return this.activateDraft(draft.revisionId, expectedRevisionId, 'rollback');
  }

  async restoreActiveSnapshot(
    revisionId: string,
    expectedActiveRevisionId: string | null,
  ): Promise<ConfigurationSnapshot> {
    await this.dependencies.repository.restoreActiveRevision(
      revisionId,
      expectedActiveRevisionId,
    );
    if (this.dependencies.renderer) {
      await this.dependencies.renderer.activateCurrent(revisionId);
    }
    return this.dependencies.repository.readSnapshot(revisionId);
  }

  async getActiveSnapshot(): Promise<ConfigurationSnapshot> {
    return this.dependencies.repository.getActiveSnapshot();
  }

  async getSnapshot(revisionId: string): Promise<ConfigurationSnapshot> {
    return this.dependencies.repository.readSnapshot(revisionId);
  }

  getDraftSnapshot(revisionId: string): ConfigurationSnapshot {
    const draft = this.requireDraft(revisionId);
    if (!draft.config) throw new Error('configuration draft must be validated before snapshot');
    const contentHash = draft.compiled?.contentHash
      ?? createHash('sha256').update(stableJson(draft.config)).digest('hex');
    return snapshotFor(draft.revisionId, contentHash, draft.config);
  }

  discardDraft(revisionId: string): void {
    this.drafts.delete(revisionId);
  }

  async previewExecutorCapabilityManual(
    agentClassRef: string,
    baseRevisionId: string,
    input: unknown,
  ): Promise<PlannerExecutorCapabilityManual> {
    await this.getSnapshot(baseRevisionId);
    const draft = this.createDraft(input, baseRevisionId);
    try {
      const validation = this.validateDraft(draft.revisionId);
      if (!validation.ok) {
        throw new Error(validation.issues
          .map(issue => `${issue.path}: ${issue.message}`)
          .join('; '));
      }
      this.compileDraft(draft.revisionId);
      const manual = buildPlannerConfigurationView(
        this.getDraftSnapshot(draft.revisionId),
      ).executorCapabilityManuals?.find(candidate => (
        candidate.agentClassRef === agentClassRef
      ));
      if (!manual) {
        throw new Error(`Executor capability manual not found: ${agentClassRef}`);
      }
      return manual;
    } finally {
      this.discardDraft(draft.revisionId);
    }
  }

  async getPlannerView(revisionId: string): Promise<PlannerConfigurationView> {
    return buildPlannerConfigurationView(await this.getSnapshot(revisionId));
  }

  async getKernelView(revisionId: string): Promise<KernelConfigurationView> {
    return buildKernelConfigurationView(await this.getSnapshot(revisionId));
  }

  async getRuntimeBinding(
    revisionId: string,
    agentClassId: string,
    modelRef: string,
  ): Promise<RuntimePrivateConfigurationBinding> {
    const snapshot = await this.getSnapshot(revisionId);
    const configuration = buildRuntimeConfigurationView(snapshot);
    const agentClass = snapshot.config.agentClasses[agentClassId];
    const model = snapshot.config.models[modelRef];
    if (!agentClass) throw new Error(`unknown AgentClass: ${agentClassId}`);
    if (!model) throw new Error(`unknown Model: ${modelRef}`);
    if (!agentClass.permissionProfileRef) {
      throw new Error(`Executor AgentClass requires a permission profile: ${agentClassId}`);
    }
    if (!this.dependencies.secretStore) {
      throw new Error('secret store is required for runtime binding');
    }
    const authorizedBinding: AuthorizedExecutorBinding = {
      agentClassRef: agentClassId,
      harnessRef: agentClass.harnessRef,
      providerRef: model.providerRef,
      modelRef,
      permissionProfileRef: agentClass.permissionProfileRef,
      configurationRevision: revisionId,
    };
    return resolveRuntimePrivateConfigurationBinding({
      configuration,
      authorizedBinding,
      secretStore: this.dependencies.secretStore,
    });
  }

  private requireDraft(revisionId: string): ConfigurationDraft {
    const draft = this.drafts.get(revisionId);
    if (!draft) throw new Error(`unknown configuration draft: ${revisionId}`);
    return draft;
  }

  private async activeRevisionId(): Promise<string | null> {
    try {
      return (await this.dependencies.repository.getActiveSnapshot()).revisionId;
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'active configuration revision is missing'
      ) {
        return null;
      }
      throw error;
    }
  }
}

export function compileConfigurationRevision(
  revisionId: string,
  config: AnyFusionConfigurationV2,
): CompiledConfigurationRevision {
  const canonical = stableJson(config);
  const contentHash = createHash('sha256').update(canonical).digest('hex');
  const snapshot = snapshotFor(revisionId, contentHash, config);
  return {
    contentHash,
    files: {
      'config.yaml': dump(config, { noRefs: true, sortKeys: true, lineWidth: -1 }),
      'kernel.json': `${JSON.stringify(buildKernelConfigurationView(snapshot), null, 2)}\n`,
      'planner.json': `${JSON.stringify(buildPlannerConfigurationView(snapshot), null, 2)}\n`,
      'runtime.json': `${JSON.stringify(buildRuntimeConfigurationView(snapshot), null, 2)}\n`,
    },
  };
}

function snapshotFor(
  revisionId: string,
  contentHash: string,
  config: AnyFusionConfigurationV2,
): ConfigurationSnapshot {
  return { revisionId, contentHash, config };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([, nested]) => nested !== undefined)
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`;
}
