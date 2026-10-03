import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ClientActionReference, ClientActionReferenceStore } from '../gateway/client-action-reference.js';

export const CLIENT_ACTION_REFERENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS client_action_signing_key (id INTEGER PRIMARY KEY CHECK(id = 1), secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_action_references (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, body_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS client_action_expiry ON client_action_references(expires_at);
`;
export class SqliteClientActionReferences implements ClientActionReferenceStore {
  constructor(private readonly db: Database.Database) {}
  signingKey(): string {
    this.db.prepare('INSERT OR IGNORE INTO client_action_signing_key(id, secret) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
    return (this.db.prepare('SELECT secret FROM client_action_signing_key WHERE id = 1').get() as { secret: string }).secret;
  }
  put(value: ClientActionReference): void {
    this.db.prepare('DELETE FROM client_action_references WHERE expires_at < ?').run(Date.now());
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM client_action_references').get() as { n: number };
    if (count.n >= 8192) throw new Error('client_action_reference_limit');
    this.db.prepare('INSERT INTO client_action_references(id, expires_at, body_json) VALUES (?, ?, ?)')
      .run(value.id, value.expiresAt, JSON.stringify(value));
  }
  find(id: string): ClientActionReference | null {
    const row = this.db.prepare('SELECT body_json FROM client_action_references WHERE id = ?').get(id) as { body_json: string } | undefined;
    return row ? JSON.parse(row.body_json) as ClientActionReference : null;
  }
}
