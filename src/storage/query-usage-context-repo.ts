/**
 * `QueryContextStore` 的 SQLite 实现（ADR-0042 §7.2）。
 *
 * 关联只由授权事实写入；`query_id` 主键与 `(account_id, ingress, request_key)`
 * 唯一约束共同保证一条 Query 只有一个收费归属。
 */

import type Database from 'better-sqlite3';
import type {
  ExecutionUsageContext,
  QueryContextStore,
  QueryIngress,
  QueryTaskLink,
  QueryUsageContext,
} from '../metering/ports.js';

interface ContextRow {
  external_account_ref: string | null;
  query_id: string;
  account_id: string;
  ingress: QueryIngress;
  request_key: string;
  request_payload_digest: string;
  conversation_id: string | null;
  request_id: string;
  turn_id: string | null;
  execution_segment_id: string | null;
  price_book_version: string;
  fee_policy_version: string;
  payer_policy_version: string;
  accepted_at: string;
}

interface LinkRow {
  query_id: string;
  cost_task_id: string;
  decision_id: string;
  basis: QueryTaskLink['basis'];
  linked_at: string;
}

interface ExecutionRow {
  execution_segment_id: string;
  query_id: string;
  kind: ExecutionUsageContext['kind'];
  reference_id: string;
  task_id: string | null;
  recorded_at: string;
}

export class SqliteQueryContextStore implements QueryContextStore {
  constructor(private readonly db: Database.Database) {}

  findByIdentity(input: {
    accountId: string;
    ingress: QueryIngress;
    requestKey: string;
  }): QueryUsageContext | null {
    const row = this.db.prepare(`
      SELECT * FROM query_usage_contexts
      WHERE account_id = ? AND ingress = ? AND request_key = ?
    `).get(input.accountId, input.ingress, input.requestKey) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  insert(context: QueryUsageContext): void {
    this.db.prepare(`
      INSERT INTO query_usage_contexts (
        query_id, account_id, ingress, request_key, request_payload_digest,
        conversation_id, request_id, turn_id, execution_segment_id,
        price_book_version, fee_policy_version, payer_policy_version, accepted_at, external_account_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.queryId,
      context.accountId,
      context.ingress,
      context.requestKey,
      context.requestPayloadDigest,
      context.conversationId,
      context.requestId,
      context.turnId,
      context.executionSegmentId,
      context.priceBookVersion,
      context.feePolicyVersion,
      context.payerPolicyVersion,
      context.acceptedAt,
      context.externalAccountRef ?? null,
    );
  }

  findTaskLink(queryId: string): QueryTaskLink | null {
    const row = this.db.prepare(
      'SELECT * FROM query_task_links WHERE query_id = ?',
    ).get(queryId) as LinkRow | undefined;
    return row ? rowToLink(row) : null;
  }

  linkTask(link: QueryTaskLink): 'linked' | 'already_linked' | 'conflict' {
    return this.db.transaction(() => {
      const existing = this.findTaskLink(link.queryId);
      if (existing) {
        return existing.costTaskId === link.costTaskId ? 'already_linked' : 'conflict';
      }
      this.db.prepare(`
        INSERT INTO query_task_links (query_id, cost_task_id, decision_id, basis, linked_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(link.queryId, link.costTaskId, link.decisionId, link.basis, link.linkedAt);
      return 'linked';
    })();
  }

  listQueryIdsForTask(taskId: string): string[] {
    const rows = this.db.prepare(`
      SELECT query_id FROM query_task_links
      WHERE cost_task_id = ?
      ORDER BY linked_at, query_id
    `).all(taskId) as Array<{ query_id: string }>;
    return rows.map(row => row.query_id);
  }

  recordExecutionContext(context: ExecutionUsageContext): void {
    this.db.prepare(`
      INSERT INTO execution_usage_contexts (
        execution_segment_id, query_id, kind, reference_id, task_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_segment_id) DO UPDATE SET
        query_id = excluded.query_id,
        kind = excluded.kind,
        reference_id = excluded.reference_id,
        task_id = excluded.task_id,
        recorded_at = excluded.recorded_at
    `).run(
      context.executionSegmentId,
      context.queryId,
      context.kind,
      context.referenceId,
      context.taskId,
      context.recordedAt,
    );
  }

  listExecutionContexts(queryId: string): ExecutionUsageContext[] {
    const rows = this.db.prepare(`
      SELECT * FROM execution_usage_contexts
      WHERE query_id = ?
      ORDER BY recorded_at, execution_segment_id
    `).all(queryId) as ExecutionRow[];
    return rows.map(row => ({
      executionSegmentId: row.execution_segment_id,
      queryId: row.query_id,
      kind: row.kind,
      referenceId: row.reference_id,
      taskId: row.task_id,
      recordedAt: row.recorded_at,
    }));
  }

  findById(queryId: string): QueryUsageContext | null {
    const row = this.db.prepare(
      'SELECT * FROM query_usage_contexts WHERE query_id = ?',
    ).get(queryId) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  findByTurnId(accountId: string, turnId: string): QueryUsageContext | null {
    const row = this.db.prepare(`
      SELECT * FROM query_usage_contexts
      WHERE account_id = ? AND turn_id = ?
      ORDER BY accepted_at DESC, query_id DESC
      LIMIT 1
    `).get(accountId, turnId) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  findForTurns(accountId: string, turnIds: readonly string[]): QueryUsageContext[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY turn_id ORDER BY accepted_at DESC, query_id DESC
        ) AS position FROM query_usage_contexts
        WHERE account_id = ? AND turn_id IN (SELECT value FROM json_each(?))
      ) WHERE position = 1
    `).all(accountId, JSON.stringify(turnIds)) as ContextRow[];
    return rows.map(rowToContext);
  }

  findByIds(queryIds: readonly string[]): QueryUsageContext[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_usage_contexts WHERE query_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(queryIds)) as ContextRow[];
    return rows.map(rowToContext);
  }

  findTaskLinks(queryIds: readonly string[]): QueryTaskLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_task_links WHERE query_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(queryIds)) as LinkRow[];
    return rows.map(rowToLink);
  }

  taskIdsForTurns(accountId: string, turnIds: readonly string[]): ReadonlyMap<string, string | null> {
    if (!turnIds.length) return new Map();
    if (turnIds.length > 100) throw new Error('history_turn_limit');
    const rows = this.db.prepare(`
      SELECT context.turn_id, link.cost_task_id FROM (
        SELECT query_id, turn_id, row_number() OVER
          (PARTITION BY turn_id ORDER BY accepted_at DESC, query_id DESC) AS position
        FROM query_usage_contexts WHERE account_id = ? AND turn_id IN (${turnIds.map(() => '?').join(',')})
      ) context LEFT JOIN query_task_links link ON link.query_id = context.query_id WHERE context.position = 1
    `).all(accountId, ...turnIds) as { turn_id: string; cost_task_id: string | null }[];
    return new Map(rows.map(row => [row.turn_id, row.cost_task_id]));
  }

  listContextsForConversation(conversationId: string): QueryUsageContext[] {
    const rows = this.db.prepare(`
      SELECT * FROM query_usage_contexts
      WHERE conversation_id = ?
      ORDER BY accepted_at, query_id
    `).all(conversationId) as ContextRow[];
    return rows.map(rowToContext);
  }
}

function rowToContext(row: ContextRow): QueryUsageContext {
  return {
    externalAccountRef: row.external_account_ref,
    queryId: row.query_id,
    accountId: row.account_id,
    ingress: row.ingress,
    requestKey: row.request_key,
    requestPayloadDigest: row.request_payload_digest,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    turnId: row.turn_id,
    executionSegmentId: row.execution_segment_id,
    priceBookVersion: row.price_book_version,
    feePolicyVersion: row.fee_policy_version,
    payerPolicyVersion: row.payer_policy_version,
    acceptedAt: row.accepted_at,
  };
}

function rowToLink(row: LinkRow): QueryTaskLink {
  return {
    queryId: row.query_id,
    costTaskId: row.cost_task_id,
    decisionId: row.decision_id,
    basis: row.basis,
    linkedAt: row.linked_at,
  };
}
