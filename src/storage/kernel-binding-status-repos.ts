import type Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type {
  AgentClassHealth,
  RecentExecutionAttempt,
  RecentExecutorRecoveryCheck,
} from '../kernel/executor-status-projection.js';

export interface KernelProviderStatusProjection {
  providerRef: string;
  configurationRevision: string;
  health: AgentClassHealth;
  recentRecoveryChecks: RecentExecutorRecoveryCheck[];
  updatedAt: string;
}

export interface KernelModelStatusProjection {
  providerRef: string;
  modelRef: string;
  configurationRevision: string;
  health: AgentClassHealth;
  recentRecoveryChecks: RecentExecutorRecoveryCheck[];
  updatedAt: string;
}

export interface KernelBindingStatusProjection {
  bindingFingerprint: string;
  binding: AuthorizedExecutorBinding;
  health: AgentClassHealth;
  recentAttempts: RecentExecutionAttempt[];
  recentRecoveryChecks: RecentExecutorRecoveryCheck[];
  updatedAt: string;
}

interface ProviderStatusRow {
  provider_ref: string;
  configuration_revision: string;
  provider_health: AgentClassHealth;
  recent_recovery_checks_json: string;
  updated_at: string;
}

interface ModelStatusRow {
  provider_ref: string;
  model_ref: string;
  configuration_revision: string;
  model_health: AgentClassHealth;
  recent_recovery_checks_json: string;
  updated_at: string;
}

interface BindingStatusRow {
  binding_fingerprint: string;
  configuration_revision: string;
  agent_class_ref: string;
  harness_ref: string;
  provider_ref: string;
  model_ref: string;
  permission_profile_ref: string;
  binding_health: AgentClassHealth;
  recent_attempts_json: string;
  recent_recovery_checks_json: string;
  updated_at: string;
}

export class KernelProviderStatusRepo {
  constructor(private readonly db: Database.Database) {}

  find(providerRef: string, configurationRevision: string): KernelProviderStatusProjection | null {
    const row = this.db.prepare(`
      SELECT * FROM kernel_provider_status
      WHERE provider_ref = ? AND configuration_revision = ?
    `).get(providerRef, configurationRevision) as ProviderStatusRow | undefined;
    return row ? providerRowToProjection(row) : null;
  }

  list(configurationRevision: string): KernelProviderStatusProjection[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_provider_status
      WHERE configuration_revision = ?
      ORDER BY provider_ref
    `).all(configurationRevision) as ProviderStatusRow[]).map(providerRowToProjection);
  }

  upsert(projection: KernelProviderStatusProjection): void {
    this.db.prepare(`
      INSERT INTO kernel_provider_status (
        provider_ref, configuration_revision, provider_health,
        recent_recovery_checks_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_ref, configuration_revision) DO UPDATE SET
        provider_health = excluded.provider_health,
        recent_recovery_checks_json = excluded.recent_recovery_checks_json,
        updated_at = excluded.updated_at
    `).run(
      projection.providerRef,
      projection.configurationRevision,
      projection.health,
      JSON.stringify(projection.recentRecoveryChecks),
      projection.updatedAt,
    );
  }
}

export class KernelModelStatusRepo {
  constructor(private readonly db: Database.Database) {}

  find(
    providerRef: string,
    modelRef: string,
    configurationRevision: string,
  ): KernelModelStatusProjection | null {
    const row = this.db.prepare(`
      SELECT * FROM kernel_model_status
      WHERE provider_ref = ? AND model_ref = ? AND configuration_revision = ?
    `).get(providerRef, modelRef, configurationRevision) as ModelStatusRow | undefined;
    return row ? modelRowToProjection(row) : null;
  }

  list(configurationRevision: string): KernelModelStatusProjection[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_model_status
      WHERE configuration_revision = ?
      ORDER BY provider_ref, model_ref
    `).all(configurationRevision) as ModelStatusRow[]).map(modelRowToProjection);
  }

  upsert(projection: KernelModelStatusProjection): void {
    this.db.prepare(`
      INSERT INTO kernel_model_status (
        provider_ref, model_ref, configuration_revision, model_health,
        recent_recovery_checks_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_ref, model_ref, configuration_revision) DO UPDATE SET
        model_health = excluded.model_health,
        recent_recovery_checks_json = excluded.recent_recovery_checks_json,
        updated_at = excluded.updated_at
    `).run(
      projection.providerRef,
      projection.modelRef,
      projection.configurationRevision,
      projection.health,
      JSON.stringify(projection.recentRecoveryChecks),
      projection.updatedAt,
    );
  }
}

export class KernelBindingStatusRepo {
  constructor(private readonly db: Database.Database) {}

  find(bindingFingerprint: string): KernelBindingStatusProjection | null {
    const row = this.db.prepare(`
      SELECT * FROM kernel_binding_status WHERE binding_fingerprint = ?
    `).get(bindingFingerprint) as BindingStatusRow | undefined;
    return row ? bindingRowToProjection(row) : null;
  }

  list(configurationRevision: string): KernelBindingStatusProjection[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_binding_status
      WHERE configuration_revision = ?
      ORDER BY agent_class_ref, model_ref, binding_fingerprint
    `).all(configurationRevision) as BindingStatusRow[]).map(bindingRowToProjection);
  }

  upsert(projection: KernelBindingStatusProjection): void {
    const existing = this.find(projection.bindingFingerprint);
    if (existing && !sameBinding(existing.binding, projection.binding)) {
      throw new Error(
        `binding fingerprint ${projection.bindingFingerprint} is already assigned to a different authorized tuple`,
      );
    }
    this.db.prepare(`
      INSERT INTO kernel_binding_status (
        binding_fingerprint, configuration_revision, agent_class_ref, harness_ref,
        provider_ref, model_ref, permission_profile_ref, binding_health,
        recent_attempts_json, recent_recovery_checks_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_fingerprint) DO UPDATE SET
        binding_health = excluded.binding_health,
        recent_attempts_json = excluded.recent_attempts_json,
        recent_recovery_checks_json = excluded.recent_recovery_checks_json,
        updated_at = excluded.updated_at
      WHERE configuration_revision = excluded.configuration_revision
        AND agent_class_ref = excluded.agent_class_ref
        AND harness_ref = excluded.harness_ref
        AND provider_ref = excluded.provider_ref
        AND model_ref = excluded.model_ref
        AND permission_profile_ref = excluded.permission_profile_ref
    `).run(
      projection.bindingFingerprint,
      projection.binding.configurationRevision,
      projection.binding.agentClassRef,
      projection.binding.harnessRef,
      projection.binding.providerRef,
      projection.binding.modelRef,
      projection.binding.permissionProfileRef,
      projection.health,
      JSON.stringify(projection.recentAttempts),
      JSON.stringify(projection.recentRecoveryChecks),
      projection.updatedAt,
    );
  }
}

function providerRowToProjection(row: ProviderStatusRow): KernelProviderStatusProjection {
  return {
    providerRef: row.provider_ref,
    configurationRevision: row.configuration_revision,
    health: row.provider_health,
    recentRecoveryChecks: JSON.parse(row.recent_recovery_checks_json) as RecentExecutorRecoveryCheck[],
    updatedAt: row.updated_at,
  };
}

function modelRowToProjection(row: ModelStatusRow): KernelModelStatusProjection {
  return {
    providerRef: row.provider_ref,
    modelRef: row.model_ref,
    configurationRevision: row.configuration_revision,
    health: row.model_health,
    recentRecoveryChecks: JSON.parse(row.recent_recovery_checks_json) as RecentExecutorRecoveryCheck[],
    updatedAt: row.updated_at,
  };
}

function bindingRowToProjection(row: BindingStatusRow): KernelBindingStatusProjection {
  return {
    bindingFingerprint: row.binding_fingerprint,
    binding: {
      agentClassRef: row.agent_class_ref,
      harnessRef: row.harness_ref,
      providerRef: row.provider_ref,
      modelRef: row.model_ref,
      permissionProfileRef: row.permission_profile_ref,
      configurationRevision: row.configuration_revision,
    },
    health: row.binding_health,
    recentAttempts: JSON.parse(row.recent_attempts_json) as RecentExecutionAttempt[],
    recentRecoveryChecks: JSON.parse(row.recent_recovery_checks_json) as RecentExecutorRecoveryCheck[],
    updatedAt: row.updated_at,
  };
}

function sameBinding(
  left: AuthorizedExecutorBinding,
  right: AuthorizedExecutorBinding,
): boolean {
  return left.agentClassRef === right.agentClassRef
    && left.harnessRef === right.harnessRef
    && left.providerRef === right.providerRef
    && left.modelRef === right.modelRef
    && left.permissionProfileRef === right.permissionProfileRef
    && left.configurationRevision === right.configurationRevision;
}
