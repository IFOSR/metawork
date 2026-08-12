import type Database from 'better-sqlite3';
import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';

export type RevisionedKernelExecutorStatusProjection = KernelExecutorStatusProjection & {
  configurationRevision: string;
};

interface StatusRow {
  agent_class_name: string;
  configuration_revision: string;
  class_health: KernelExecutorStatusProjection['classHealth'];
  recent_attempts_json: string;
  recent_recovery_checks_json: string;
  updated_at: string;
}

export class KernelExecutorStatusRepo {
  constructor(private readonly db: Database.Database) {}

  findByAgentClassName(
    agentClassName: string,
    configurationRevision: string,
  ): RevisionedKernelExecutorStatusProjection | null {
    const row = this.db.prepare(`
      SELECT * FROM kernel_executor_status
      WHERE agent_class_name = ? AND configuration_revision = ?
    `).get(agentClassName, configurationRevision) as StatusRow | undefined;
    return row ? rowToProjection(row) : null;
  }

  list(configurationRevision: string): RevisionedKernelExecutorStatusProjection[] {
    return (this.db.prepare(`
      SELECT * FROM kernel_executor_status
      WHERE configuration_revision = ?
      ORDER BY agent_class_name
    `).all(configurationRevision) as StatusRow[])
      .map(rowToProjection);
  }

  upsert(projection: RevisionedKernelExecutorStatusProjection): void {
    this.db.prepare(`
      INSERT INTO kernel_executor_status (
        agent_class_name, configuration_revision, class_health,
        recent_attempts_json, recent_recovery_checks_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_class_name, configuration_revision) DO UPDATE SET
        class_health = excluded.class_health,
        recent_attempts_json = excluded.recent_attempts_json,
        recent_recovery_checks_json = excluded.recent_recovery_checks_json,
        updated_at = excluded.updated_at
    `).run(
      projection.agentClassName,
      projection.configurationRevision,
      projection.classHealth,
      JSON.stringify(projection.recentAttempts),
      JSON.stringify(projection.recentRecoveryChecks),
      projection.updatedAt,
    );
  }
}

function rowToProjection(row: StatusRow): RevisionedKernelExecutorStatusProjection {
  const recentAttempts = JSON.parse(
    row.recent_attempts_json,
  ) as KernelExecutorStatusProjection['recentAttempts'];
  const recentRecoveryChecks = JSON.parse(
    row.recent_recovery_checks_json,
  ) as KernelExecutorStatusProjection['recentRecoveryChecks'];
  return {
    agentClassName: row.agent_class_name,
    configurationRevision: row.configuration_revision,
    classHealth: row.class_health,
    recentAttempts,
    recentRecoveryChecks,
    updatedAt: row.updated_at,
  };
}
