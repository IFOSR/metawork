import type Database from 'better-sqlite3';
import type { LocalServiceRecord, LocalServiceStore, LocalServiceEffect } from '../task/local-service.js';
import { localServiceSpecificationRevision } from '../task/local-service.js';

interface Row {
  source_commit:string|null;source_task_id:string|null;operation_task_id:string|null;project_path:string|null;service_worktree_id:string|null;
  account_id: string; workspace_id: string | null; specification_revision: string | null;
  specification_json: string; state: LocalServiceRecord['state'];
  process_id: number | null; process_token: string | null; health_message: string | null; updated_at: string;
}
function fromRow(row: Row): LocalServiceRecord {
  const specification = JSON.parse(row.specification_json) as LocalServiceRecord['specification'];
  return {
    ...(row.source_commit?{sourceCommit:row.source_commit,sourceTaskId:row.source_task_id,operationTaskId:row.operation_task_id,projectPath:row.project_path,serviceWorktreeId:row.service_worktree_id}:{}),
    accountId: row.account_id,
    // The composite key needs a non-null segment; `null` is its public spelling.
    workspaceId: row.workspace_id || null,
    specificationRevision: row.specification_revision
      || localServiceSpecificationRevision(specification),
    specification,
    state: row.state,
    processId: row.process_id,
    processToken: row.process_token,
    healthMessage: row.health_message,
    updatedAt: row.updated_at,
  };
}
export class ManagedLocalServiceRepo implements LocalServiceStore {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {}
  findOperation(decisionId: string): LocalServiceEffect | null {
    const row = this.db.prepare('SELECT effect_json FROM managed_local_service_effects WHERE account_id = ? AND decision_id = ?')
      .get(this.accountId, decisionId) as { effect_json: string } | undefined;
    return row ? JSON.parse(row.effect_json) as LocalServiceEffect : null;
  }
  saveOperation(effect: LocalServiceEffect): void {
    this.db.prepare(`INSERT INTO managed_local_service_effects(account_id, decision_id, effect_json) VALUES (?,?,?)
      ON CONFLICT(account_id, decision_id) DO UPDATE SET effect_json=excluded.effect_json`)
      .run(this.accountId, effect.decisionId, JSON.stringify(effect));
  }
  find(id: string): LocalServiceRecord | null {
    // A service id is only unique per Workspace, so a bare lookup reports the
    // row only when the account has exactly one registration with that id.
    const rows = this.db.prepare(
      'SELECT * FROM managed_local_services WHERE service_id = ? AND account_id = ?',
    ).all(id, this.accountId) as Row[];
    if (rows.length === 0) return null;
    if (rows.length > 1 && new Set(rows.map(row => row.workspace_id ?? '')).size > 1) {
      throw new Error('服务标识在多个 Workspace 重复；请按 Workspace 查询');
    }
    return fromRow(rows[0]!);
  }

  findInWorkspace(workspaceId: string, serviceId: string): LocalServiceRecord | null {
    const row = this.db.prepare(`SELECT * FROM managed_local_services
      WHERE account_id = ? AND workspace_id = ? AND service_id = ?`)
      .get(this.accountId, workspaceId, serviceId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(): LocalServiceRecord[] {
    return (this.db.prepare('SELECT * FROM managed_local_services WHERE account_id = ?').all(this.accountId) as Row[]).map(fromRow);
  }
  /**
   * Authorized revision is immutable per (account, task, service). A later
   * Attempt that rewrites the specification therefore cannot launch it without
   * an explicit Kernel update decision.
   */
  findAuthorizedRevision(accountId: string, taskId: string, serviceId: string): string | null {
    if (accountId !== this.accountId) return null;
    const row = this.db.prepare(`SELECT specification_revision FROM managed_local_services
      WHERE service_id = ? AND account_id = ? AND task_id = ?`)
      .get(serviceId, this.accountId, taskId) as { specification_revision: string | null } | undefined;
    return row?.specification_revision || null;
  }

  save(record: LocalServiceRecord, options: { allowSpecificationChange?: boolean } = {}): void {
    if (record.accountId !== this.accountId) throw new Error('服务账户不匹配');
    const storedRevision = localServiceSpecificationRevision(record.specification);
    const revision = record.specificationRevision || storedRevision;
    // The row must describe one launch contract: a caller cannot pair a new
    // specification with a stale revision to bypass the explicit update path.
    if (revision !== storedRevision && !options.allowSpecificationChange) {
      throw new Error('服务标识已绑定其他启动规格');
    }
    // The launch contract revision, not the owning Task, is the identity of a
    // specification. Restarting the same contract from a later Task is a
    // handover of provenance: the row keeps describing the *current*
    // specification instead of resurrecting a historical Task.
    const result = this.db.prepare(`INSERT INTO managed_local_services(
      service_id, account_id, workspace_id, task_id, specification_revision, specification_json,
      state, process_id, process_token, health_message, updated_at, source_commit,source_task_id,operation_task_id,project_path,service_worktree_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, workspace_id, service_id) DO UPDATE
      SET task_id=CASE WHEN ? OR managed_local_services.specification_revision = excluded.specification_revision
          THEN excluded.task_id ELSE managed_local_services.task_id END,
        specification_revision=CASE WHEN ? OR managed_local_services.specification_revision = ''
          THEN excluded.specification_revision ELSE managed_local_services.specification_revision END,
        specification_json=CASE WHEN ? OR managed_local_services.specification_revision = excluded.specification_revision
          THEN excluded.specification_json ELSE managed_local_services.specification_json END,
        source_commit=excluded.source_commit,source_task_id=excluded.source_task_id,operation_task_id=excluded.operation_task_id,project_path=excluded.project_path,service_worktree_id=excluded.service_worktree_id,
        state=excluded.state, process_id=excluded.process_id,
        process_token=excluded.process_token, health_message=excluded.health_message, updated_at=excluded.updated_at
      WHERE (? OR managed_local_services.specification_revision = ''
        OR managed_local_services.specification_revision = excluded.specification_revision)`)
      .run(record.specification.serviceId, this.accountId, record.workspaceId ?? '',
        record.specification.taskId, revision, JSON.stringify(record.specification),
        record.state, record.processId, record.processToken, record.healthMessage, record.updatedAt,
        record.sourceCommit??null,record.sourceTaskId??null,record.operationTaskId??null,record.projectPath??null,record.serviceWorktreeId??null,
        options.allowSpecificationChange ? 1 : 0,
        options.allowSpecificationChange ? 1 : 0,
        options.allowSpecificationChange ? 1 : 0,
        options.allowSpecificationChange ? 1 : 0);
    if (result.changes !== 1) throw new Error('服务标识已绑定其他启动规格');
  }
}
