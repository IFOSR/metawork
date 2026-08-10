import type Database from 'better-sqlite3';
import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';

interface StatusRow {
  agent_class_name: string;
  class_health: KernelExecutorStatusProjection['classHealth'];
  recent_attempts_json: string;
  recent_recovery_checks_json: string;
  updated_at: string;
}

export class KernelExecutorStatusRepo {
  constructor(private readonly db: Database.Database) {}

  findByAgentClassName(agentClassName: string): KernelExecutorStatusProjection | null {
    const row = this.db.prepare('SELECT * FROM kernel_executor_status WHERE agent_class_name = ?')
      .get(agentClassName) as StatusRow | undefined;
    return row ? rowToProjection(row) : null;
  }

  list(): KernelExecutorStatusProjection[] {
    return (this.db.prepare('SELECT * FROM kernel_executor_status ORDER BY agent_class_name').all() as StatusRow[])
      .map(rowToProjection);
  }

  upsert(projection: KernelExecutorStatusProjection): void {
    this.db.prepare(`
      INSERT INTO kernel_executor_status (
        agent_class_name, class_health, recent_attempts_json, recent_recovery_checks_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_class_name) DO UPDATE SET
        class_health = excluded.class_health,
        recent_attempts_json = excluded.recent_attempts_json,
        recent_recovery_checks_json = excluded.recent_recovery_checks_json,
        updated_at = excluded.updated_at
    `).run(
      projection.agentClassName,
      projection.classHealth,
      JSON.stringify(projection.recentAttempts),
      JSON.stringify(projection.recentRecoveryChecks),
      projection.updatedAt,
    );
  }
}

function rowToProjection(row: StatusRow): KernelExecutorStatusProjection {
  let recentAttempts: KernelExecutorStatusProjection['recentAttempts'] = [];
  let recentRecoveryChecks: KernelExecutorStatusProjection['recentRecoveryChecks'] = [];
  try { recentAttempts = JSON.parse(row.recent_attempts_json) as KernelExecutorStatusProjection['recentAttempts']; } catch { /* corrupt legacy values are safely empty */ }
  try { recentRecoveryChecks = JSON.parse(row.recent_recovery_checks_json) as KernelExecutorStatusProjection['recentRecoveryChecks']; } catch { /* corrupt values are safely empty */ }
  return {
    agentClassName: row.agent_class_name,
    classHealth: row.class_health,
    recentAttempts,
    recentRecoveryChecks,
    updatedAt: row.updated_at,
  };
}
