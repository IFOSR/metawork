import type Database from 'better-sqlite3';
import type { KernelEvent } from '../kernel/control-kernel.js';
import { resolveDerivedContent, storeDerivedContent } from './conversation-content-references.js';

/** Only request text is reference-backed; policy events retain their original shape on reads. */
export function encodeKernelEvent(db: Database.Database, event: KernelEvent): string {
  if (event.type !== 'plan_proposed') return JSON.stringify(event);
  const conversationId = event.conversationId ?? event.sessionId;
  const owner = db.prepare('SELECT account_id FROM conversation_metadata_projection WHERE conversation_id = ?')
    .get(conversationId) as { account_id: string } | undefined;
  if (!owner) return JSON.stringify(event);
  const requestTextRef = storeDerivedContent(db, { accountId: owner.account_id, conversationId,
    turnId: event.sourceTurnId ?? null, kind: 'kernel_request', text: event.requestText });
  const { requestText: _text, ...metadata } = event;
  return JSON.stringify({ ...metadata, requestTextRef });
}
export function decodeKernelEvent(db: Database.Database, raw: string): string {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value.requestTextRef !== 'string') return raw;
  const { requestTextRef, ...metadata } = value;
  return JSON.stringify({ ...metadata, requestText: resolveDerivedContent(db, requestTextRef) });
}
