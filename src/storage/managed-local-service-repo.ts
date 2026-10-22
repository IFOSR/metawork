import type Database from 'better-sqlite3';
import type { LocalServiceRecord, LocalServiceStore, LocalServiceEffect } from '../task/local-service.js';

interface Row {
  account_id: string; specification_json: string; state: LocalServiceRecord['state'];
  process_id: number | null; process_token: string | null; health_message: string | null; updated_at: string;
}
function fromRow(row: Row): LocalServiceRecord {
  return { accountId: row.account_id, specification: JSON.parse(row.specification_json), state: row.state,
    processId: row.process_id, processToken: row.process_token, healthMessage: row.health_message, updatedAt: row.updated_at };
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
    const row = this.db.prepare('SELECT * FROM managed_local_services WHERE service_id = ? AND account_id = ?')
      .get(id, this.accountId) as Row | undefined;
    return row ? fromRow(row) : null;
  }
  list(): LocalServiceRecord[] {
    return (this.db.prepare('SELECT * FROM managed_local_services WHERE account_id = ?').all(this.accountId) as Row[]).map(fromRow);
  }
  save(record: LocalServiceRecord): void {
    if (record.accountId !== this.accountId) throw new Error('服务账户不匹配');
    const result = this.db.prepare(`INSERT INTO managed_local_services(service_id, account_id, task_id, specification_json,
      state, process_id, process_token, health_message, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(service_id) DO UPDATE SET state=excluded.state, process_id=excluded.process_id,
      process_token=excluded.process_token, health_message=excluded.health_message, updated_at=excluded.updated_at
      WHERE account_id=excluded.account_id AND specification_json=excluded.specification_json`)
      .run(record.specification.serviceId, this.accountId, record.specification.taskId, JSON.stringify(record.specification),
        record.state, record.processId, record.processToken, record.healthMessage, record.updatedAt);
    if (result.changes !== 1) throw new Error('服务标识已绑定其他启动规格');
  }
}
