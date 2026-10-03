import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NotificationFact, NotificationFactPage, NotificationJob, NotificationRoute, NotificationRoutingStore } from '../delivery/notification-routing.js';
import { NOTIFICATION_FACT_BYTES, NOTIFICATION_READY_JOB_LIMIT } from '../delivery/notification-routing.js';

export const NOTIFICATION_ROUTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_route_seeds (
  route_id TEXT PRIMARY KEY, route_revision INTEGER NOT NULL, cursor TEXT
);
CREATE TABLE IF NOT EXISTS notification_permission_scans (
  task_id TEXT PRIMARY KEY, after_id TEXT NOT NULL DEFAULT '', rescan INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notification_routes (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, request_id TEXT, task_id TEXT, body_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS notification_route_match ON notification_routes(account_id, conversation_id, enabled);
CREATE INDEX IF NOT EXISTS notification_route_owner ON notification_routes(account_id, principal_id, enabled, id);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY, route_id TEXT NOT NULL, route_revision INTEGER NOT NULL,
  subject_id TEXT NOT NULL, category TEXT NOT NULL, version TEXT NOT NULL,
  body_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL, claim_token TEXT, lease_until INTEGER,
  UNIQUE(route_id, route_revision, subject_id, category, version)
);
CREATE INDEX IF NOT EXISTS notification_outbox_ready ON notification_outbox(state, available_at);
CREATE INDEX IF NOT EXISTS notification_outbox_route ON notification_outbox(route_id, subject_id, category, state);
`;

export class SqliteNotificationRoutingStore implements NotificationRoutingStore {
  constructor(private readonly db: Database.Database) {}
  private hasReadyCapacity(): boolean {
    return (this.db.prepare(`SELECT count(*) AS n FROM notification_outbox WHERE state IN ('pending', 'sending')`).get() as { n: number }).n < NOTIFICATION_READY_JOB_LIMIT;
  }
  upsert(input: Omit<NotificationRoute, 'revision' | 'enabled'>): NotificationRoute {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT body_json, revision, enabled FROM notification_routes WHERE id = ?')
        .get(input.id) as { body_json: string; revision: number; enabled: number } | undefined;
      if (!existing?.enabled) {
        const count = this.db.prepare('SELECT count(*) AS n FROM notification_routes WHERE account_id = ? AND enabled = 1 AND expires_at IS NULL')
          .get(input.accountId) as { n: number };
        if (count.n >= 512) throw new Error('notification_route_limit');
      }
      const revision = existing ? existing.revision + (existing.enabled ? 0 : 1) : 1;
      const route = { ...input, revision, enabled: true };
      this.db.prepare(`INSERT INTO notification_routes(id, account_id, principal_id, conversation_id, request_id, task_id, body_json, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        enabled = 1, expires_at = NULL, revision = excluded.revision, body_json = excluded.body_json`)
        .run(route.id, route.accountId, route.principalId, route.conversationId, route.requestId, route.taskId, JSON.stringify(route), revision);
      if (!existing?.enabled && route.source === 'explicit_follow') this.db.prepare(`INSERT INTO notification_route_seeds(route_id, route_revision)
        VALUES (?, ?) ON CONFLICT(route_id) DO UPDATE SET route_revision = excluded.route_revision, cursor = NULL`).run(route.id, revision);
      return route;
    }).immediate();
  }
  disable(accountId: string, principalId: string, routeId: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE notification_routes SET enabled = 0, revision = revision + 1
        WHERE id = ? AND account_id = ? AND principal_id = ? AND enabled = 1`).run(routeId, accountId, principalId);
      if (result.changes) this.db.prepare("UPDATE notification_outbox SET state = 'revoked' WHERE route_id = ? AND state IN ('pending', 'sending', 'deferred')").run(routeId);
      if (result.changes) this.db.prepare('DELETE FROM notification_route_seeds WHERE route_id = ?').run(routeId);
      return result.changes > 0;
    }).immediate();
  }
  nextSeed(routeId?: string) {
    const row = this.db.prepare(`SELECT route.body_json, seed.cursor FROM notification_route_seeds seed
      JOIN notification_routes route ON route.id = seed.route_id AND route.revision = seed.route_revision AND route.enabled = 1
      ${routeId ? 'WHERE seed.route_id = ?' : ''} ORDER BY seed.rowid LIMIT 1`)
      .get(...(routeId ? [routeId] : [])) as { body_json: string; cursor: string | null } | undefined;
    return row ? { route: JSON.parse(row.body_json) as NotificationRoute, cursor: row.cursor } : null;
  }
  commitSeed(route: NotificationRoute, cursor: string | null, page: NotificationFactPage, now: number): void {
    this.db.transaction(() => {
      const match = this.db.prepare(`SELECT 1 FROM notification_route_seeds WHERE route_id = ? AND route_revision = ? AND cursor IS ?`)
        .get(route.id, route.revision, cursor);
      if (!match) return;
      for (const fact of page.facts) this.capture(fact, now);
      if (page.nextCursor === null) this.db.prepare('DELETE FROM notification_route_seeds WHERE route_id = ?').run(route.id);
      else this.db.prepare(`UPDATE notification_route_seeds SET cursor = ?,
        rowid = (SELECT coalesce(max(rowid), 0) + 1 FROM notification_route_seeds) WHERE route_id = ?`).run(page.nextCursor, route.id);
    }).immediate();
  }
  schedulePermissions(taskId: string): void {
    this.db.prepare(`INSERT INTO notification_permission_scans(task_id) VALUES (?)
      ON CONFLICT(task_id) DO UPDATE SET rescan = 1`).run(taskId);
  }
  scanPermissions(read: (taskId: string, afterId: string) => { facts: readonly NotificationFact[]; nextId: string | null }, now: number): void {
    this.db.transaction(() => {
      const scan = this.db.prepare('SELECT task_id, after_id, rescan FROM notification_permission_scans ORDER BY rowid LIMIT 1')
        .get() as { task_id: string; after_id: string; rescan: number } | undefined;
      if (!scan) return;
      const page = read(scan.task_id, scan.after_id);
      for (const fact of page.facts) this.capture(fact, now);
      if (page.nextId === null && !scan.rescan) this.db.prepare('DELETE FROM notification_permission_scans WHERE task_id = ?').run(scan.task_id);
      else this.db.prepare(`UPDATE notification_permission_scans SET after_id = ?, rescan = ?,
        rowid = (SELECT coalesce(max(rowid), 0) + 1 FROM notification_permission_scans) WHERE task_id = ?`)
        .run(page.nextId ?? '', page.nextId === null ? 0 : scan.rescan, scan.task_id);
    }).immediate();
  }
  list(accountId: string, principalId: string, afterId = ''): NotificationRoute[] {
    return (this.db.prepare(`SELECT body_json FROM notification_routes WHERE account_id = ? AND principal_id = ?
      AND enabled = 1 AND id > ? ORDER BY id LIMIT 33`).all(accountId, principalId, afterId) as Array<{ body_json: string }>)
      .map(row => JSON.parse(row.body_json) as NotificationRoute);
  }
  capture(fact: NotificationFact, now: number): void {
    const body = JSON.stringify(fact);
    if (Buffer.byteLength(body) > NOTIFICATION_FACT_BYTES) throw new Error('notification_fact_budget');
    this.db.transaction(() => {
      const routes = this.db.prepare(`SELECT id, revision FROM notification_routes WHERE account_id = ? AND conversation_id = ?
        AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?) AND (request_id IS NULL OR request_id = ?) AND (task_id IS NULL OR task_id = ?)`)
        .all(fact.accountId, fact.conversationId, now, fact.requestId, fact.taskId) as Array<{ id: string; revision: number }>;
      for (const route of routes) {
        const id = createHash('sha256').update(JSON.stringify([route.id, route.revision, fact.subjectId, fact.category, fact.version])).digest('hex');
        // A fact is delivered independently per destination. Repeated source writes are no-ops.
        if (this.db.prepare('SELECT 1 FROM notification_outbox WHERE id = ?').get(id)) continue;
        const pendingProgress = fact.category === 'progress' ? this.db.prepare(`SELECT min(available_at) AS available_at
          FROM notification_outbox WHERE route_id = ? AND subject_id = ? AND category = 'progress' AND state IN ('pending', 'deferred')`)
          .get(route.id, fact.subjectId) as { available_at: number | null } : null;
        if (fact.category === 'progress') this.db.prepare(`DELETE FROM notification_outbox
          WHERE route_id = ? AND subject_id = ? AND category = 'progress' AND state IN ('pending', 'deferred')`).run(route.id, fact.subjectId);
        this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
          (id, route_id, route_revision, subject_id, category, version, body_json, state, available_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, route.id, route.revision, fact.subjectId, fact.category, fact.version, body, this.hasReadyCapacity() ? 'pending' : 'deferred',
            fact.category === 'progress' && (fact.payload as { canCancel?: boolean }).canCancel !== false
              ? pendingProgress?.available_at ?? now + 2_000 : now);
      }
    }).immediate();
  }
  renew(job: NotificationJob, now: number): boolean {
    return this.db.prepare(`UPDATE notification_outbox SET lease_until = ? WHERE id = ? AND state = 'sending'
      AND claim_token = ? AND EXISTS (SELECT 1 FROM notification_routes route WHERE route.id = route_id
        AND route.enabled = 1 AND route.revision = route_revision)`).run(now + 120_000, job.id, job.token).changes > 0;
  }
  claim(now: number, token: string, excludedRouteIds: readonly string[] = []): NotificationJob | null {
    return this.db.transaction(() => {
      // Completed default replies keep a correction window without consuming active-follow slots.
      this.db.prepare(`UPDATE notification_routes SET enabled = 0, revision = revision + 1 WHERE id IN (
        SELECT id FROM notification_routes WHERE enabled = 1 AND expires_at <= ? LIMIT 64)`).run(now);
      this.db.prepare(`DELETE FROM notification_outbox WHERE rowid IN (
        SELECT job.rowid FROM notification_outbox job JOIN notification_routes route ON route.id = job.route_id
        WHERE route.enabled = 0 AND job.available_at < ? LIMIT 128)`).run(now - 7 * 24 * 60 * 60 * 1000);
      // Terminal delivery receipts have a seven-day deduplication window. Pending
      // results/approvals are durable intents and are never discarded by this GC.
      this.db.prepare(`DELETE FROM notification_outbox WHERE rowid IN (
        SELECT rowid FROM notification_outbox WHERE state IN ('delivered', 'superseded', 'revoked')
          AND available_at < ? ORDER BY available_at LIMIT 128)`).run(now - 7 * 24 * 60 * 60 * 1000);
      this.db.prepare(`DELETE FROM notification_routes WHERE id IN (
        SELECT route.id FROM notification_routes route WHERE route.enabled = 0
          AND NOT EXISTS (SELECT 1 FROM notification_outbox job WHERE job.route_id = route.id) LIMIT 32)`)
        .run();
      this.db.prepare("UPDATE notification_outbox SET state = 'pending', claim_token = NULL WHERE state = 'sending' AND lease_until < ?").run(now);
      // One disk-spooled intent enters the bounded ready pool per claim. This
      // survives restart and never relies on re-running a Task or an audit scan.
      if (this.hasReadyCapacity()) this.db.prepare(`UPDATE notification_outbox SET state = 'pending' WHERE id = (
        SELECT job.id FROM notification_outbox job JOIN notification_routes route
          ON route.id = job.route_id AND route.enabled = 1 AND route.revision = job.route_revision
        WHERE job.state = 'deferred' AND job.available_at <= ? ORDER BY job.available_at, job.id LIMIT 1)`).run(now);
      const row = this.db.prepare(`SELECT job.id, job.body_json, job.attempts, route.body_json AS route_json FROM notification_outbox job
        JOIN notification_routes route ON route.id = job.route_id AND route.enabled = 1 AND route.revision = job.route_revision
        WHERE job.state = 'pending' AND job.available_at <= ?
          ${excludedRouteIds.length ? `AND route.id NOT IN (${excludedRouteIds.map(() => '?').join(',')})` : ''}
        ORDER BY job.available_at, job.id LIMIT 1`).get(now, ...excludedRouteIds) as
        { id: string; body_json: string; route_json: string; attempts: number } | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE notification_outbox SET state = 'sending', claim_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?")
        .run(token, now + 120_000, row.id);
      return { id: row.id, token, attempts: row.attempts, route: JSON.parse(row.route_json) as NotificationRoute,
        fact: JSON.parse(row.body_json) as NotificationFact };
    }).immediate();
  }
  settle(job: NotificationJob, outcome: 'delivered' | 'superseded' | 'revoked' | 'retry', now: number, retryAt = now): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE notification_outbox SET state = ?, available_at = ?, claim_token = NULL, lease_until = NULL
        WHERE id = ? AND state = 'sending' AND claim_token = ?`).run(outcome === 'retry' ? 'pending' : outcome, retryAt, job.id, job.token);
      if (result.changes && outcome === 'revoked') this.disable(job.route.accountId, job.route.principalId, job.route.id);
      if (result.changes && outcome === 'delivered' && job.fact.category === 'result' && job.route.source === 'default_reply'
        && (job.fact.payload as { deliveryStatus?: string }).deliveryStatus === 'ready') {
        this.db.prepare('UPDATE notification_routes SET expires_at = ? WHERE id = ? AND revision = ?')
          .run(now + 24 * 60 * 60 * 1000, job.route.id, job.route.revision);
        this.db.prepare(`UPDATE notification_outbox SET state = 'superseded' WHERE route_id = ? AND state IN ('pending', 'deferred')
          AND category = 'progress' AND json_extract(body_json, '$.payload.canCancel') IS NOT 0`).run(job.route.id);
      }
    }).immediate();
  }
}
