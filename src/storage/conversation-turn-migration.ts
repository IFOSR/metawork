import type Database from 'better-sqlite3';
import { resolveDerivedContent } from './conversation-content-references.js';
import type { GatewayEventEnvelope } from '../gateway/client-events.js';
import { SqliteConversationReadModel } from './conversation-read-model-repo.js';
import { digest, SqliteConversationTurnStore } from './conversation-turn-repo.js';

type Classification = 'exact_match' | 'recoverable_single_source' | 'conflict' | 'missing';
interface CandidateEvidence { source: string; hash: string; byteLength: number }
export interface TurnMigrationReport {
  turnId: string;
  classification: Classification;
  inputHash: string | null;
  answerHash: string | null;
  reason: string;
  candidates: CandidateEvidence[];
  cutoverAt?: string;
  retiredAt?: string;
}

export const LEGACY_CONTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Review never writes. Cutover is atomic for one conversation and never chooses a preview. */
export class SqliteConversationTurnMigration {
  constructor(private readonly db: Database.Database) {}

  review(accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[]): TurnMigrationReport[] {
    return this.candidates(accountId, conversationId, events).map(candidate => candidate.report);
  }

  migrate(accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[]): TurnMigrationReport[] {
    const candidates = this.candidates(accountId, conversationId, events);
    const reports = candidates.map(candidate => candidate.report);
    if (reports.some(r => r.classification === 'conflict' || r.classification === 'missing')) {
      this.saveReports(accountId, conversationId, reports);
      return reports;
    }
    const store = new SqliteConversationTurnStore(this.db);
    // Do not insert older turns after a live stream has already assigned its order.
    // Such a stream needs an explicit offline reordering migration, not silent renumbering.
    const last = this.db.prepare(`SELECT MAX(created_at) AS stamp FROM conversation_turns
      WHERE account_id = ? AND conversation_id = ?`).get(accountId, conversationId) as { stamp: string | null };
    if (last.stamp && candidates.some(c => c.input !== null && c.start.occurredAt < last.stamp!)) {
      const conflicts = reports.map(report => ({ ...report, classification: 'conflict' as const, reason: 'offline_order_reconciliation_required' }));
      this.saveReports(accountId, conversationId, conflicts);
      return conflicts;
    }
    this.saveReports(accountId, conversationId, reports);
    this.db.transaction(() => {
      for (const candidate of candidates) {
        const identity = { accountId, conversationId, turnId: candidate.report.turnId };
        if (store.find(identity)) continue;
        const startId = `migration:start:${candidate.report.turnId}`;
        const answerId = `migration:answer:${candidate.report.turnId}`;
        store.accept({ ...identity, userInput: candidate.input!, requestKey: `migration:${candidate.report.turnId}`,
          event: { ...candidate.start, eventId: startId } });
        if (candidate.answer !== null) store.appendFinalAnswer({ ...identity, content: candidate.answer,
          revisionKey: 'migration:1', sourceTaskId: candidate.taskId,
          event: { ...candidate.end!, eventId: answerId } });
        const actual = store.find(identity)!;
        if (actual.input.hash !== candidate.report.inputHash || (actual.answer?.hash ?? null) !== candidate.report.answerHash) {
          throw new Error('turn_migration_verification_failed');
        }
        // Preserve execution metadata and status; importing an answer is not Task success.
        if (candidate.history) {
          const encoded = JSON.stringify(store.encodeHistory(accountId, conversationId, candidate.history));
          this.db.prepare(`UPDATE conversation_history_turns SET body_json = ?, byte_length = ?
            WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND kind = 'conversation'`)
            .run(encoded, Buffer.byteLength(encoded), accountId, conversationId, identity.turnId);
        }
        for (const row of this.db.prepare(`SELECT kind, body_json FROM conversation_history_turns
          WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`).all(accountId, conversationId, identity.turnId) as
          { kind: string; body_json: string }[]) {
          const encoded = JSON.stringify(store.encodeHistory(accountId, conversationId, JSON.parse(row.body_json)));
          this.db.prepare(`UPDATE conversation_history_turns SET body_json = ?, byte_length = ?
            WHERE account_id = ? AND conversation_id = ? AND turn_id = ? AND kind = ?`)
            .run(encoded, Buffer.byteLength(encoded), accountId, conversationId, identity.turnId, row.kind);
        }
        // Historical import must never emit new live answers or notifications.
        store.acknowledgeEvent(accountId, startId);
        store.acknowledgeEvent(accountId, answerId);
      }
      for (const report of reports) {
        const old = this.db.prepare(`SELECT evidence_json FROM conversation_turn_migration
          WHERE account_id = ? AND conversation_id = ? AND turn_id = ?`).get(accountId, conversationId, report.turnId) as { evidence_json: string };
        const prior = JSON.parse(old.evidence_json) as TurnMigrationReport;
        this.saveReports(accountId, conversationId, [{ ...report,
          cutoverAt: prior.cutoverAt ?? new Date().toISOString(), retiredAt: prior.retiredAt }]);
      }
    }).immediate();
    return reports;
  }

  /** Only fully proven conversations can retire their rollback copies. */
  canRetire(accountId: string, conversationId: string, now = Date.now()): boolean {
    const reports = this.db.prepare(`SELECT evidence_json FROM conversation_turn_migration
      WHERE account_id = ? AND conversation_id = ?`).all(accountId, conversationId) as { evidence_json: string }[];
    if (!reports.length) return false;
    const evidence = reports.map(row => JSON.parse(row.evidence_json) as TurnMigrationReport);
    if (evidence.every(row => row.retiredAt)) return false;
    if (evidence.some(row => !row.cutoverAt || !Number.isFinite(Date.parse(row.cutoverAt))
      || now - Date.parse(row.cutoverAt) < LEGACY_CONTENT_RETENTION_MS
      || row.classification === 'conflict' || row.classification === 'missing')) return false;
    if (this.db.prepare(`SELECT 1 FROM conversation_history_turns h WHERE account_id = ? AND conversation_id = ?
      AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.account_id = h.account_id
        AND t.conversation_id = h.conversation_id AND t.turn_id = h.turn_id) LIMIT 1`).get(accountId, conversationId)) return false;
    const store = new SqliteConversationTurnStore(this.db);
    for (const report of evidence) {
      const turn = store.find({ accountId, conversationId, turnId: report.turnId });
      if (!turn || turn.input.hash !== report.inputHash) throw new Error('turn_migration_verification_failed');
      store.readBody(accountId, turn.input.hash);
      if (report.answerHash) {
        if (!this.db.prepare(`SELECT 1 FROM conversation_turn_answers WHERE account_id = ? AND conversation_id = ?
          AND turn_id = ? AND body_hash = ?`).get(accountId, conversationId, report.turnId, report.answerHash)) throw new Error('turn_migration_verification_failed');
        store.readBody(accountId, report.answerHash);
      }
    }
    return true;
  }

  retireCopies(accountId: string, conversationId: string, now = Date.now()): void {
    this.db.transaction(() => {
      if (!this.canRetire(accountId, conversationId, now)) return;
      for (const table of ['conversation_read_bodies', 'conversation_read_content_chunks', 'conversation_read_content_manifests']) {
        this.db.prepare(`DELETE FROM ${table} WHERE account_id = ? AND conversation_id = ? AND hash IN (
          SELECT user_input_hash FROM conversation_turns WHERE account_id = ? AND conversation_id = ?
          UNION SELECT body_hash FROM conversation_turn_answers WHERE account_id = ? AND conversation_id = ?)`)
          .run(accountId, conversationId, accountId, conversationId, accountId, conversationId);
      }
      this.db.prepare(`UPDATE conversation_turn_migration SET evidence_json = json_set(evidence_json, '$.retiredAt', ?)
        WHERE account_id = ? AND conversation_id = ?`).run(new Date(now).toISOString(), accountId, conversationId);
    }).immediate();
  }

  private saveReports(accountId: string, conversationId: string, reports: TurnMigrationReport[]): void {
    this.db.transaction(() => {
      for (const report of reports) this.db.prepare(`INSERT INTO conversation_turn_migration
        (account_id, conversation_id, turn_id, classification, evidence_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, turn_id) DO UPDATE SET
        classification = excluded.classification, evidence_json = CASE
          WHEN excluded.classification IN ('conflict','missing') THEN excluded.evidence_json
          ELSE json_patch(conversation_turn_migration.evidence_json, excluded.evidence_json) END`)
        .run(accountId, conversationId, report.turnId, report.classification, JSON.stringify(report));
    }).immediate();
  }

  private candidates(accountId: string, conversationId: string, sourceEvents: readonly GatewayEventEnvelope[]) {
    if (sourceEvents.some(e => e.accountId !== accountId || e.conversationId !== conversationId)) throw new Error('migration_scope_mismatch');
    const events = [...new Map(sourceEvents.map(e => [e.eventId, e])).values()].sort((a, b) => a.sequence - b.sequence);
    const model = new SqliteConversationReadModel(this.db);
    const store = new SqliteConversationTurnStore(this.db);
    if (store.deletionState(accountId, conversationId)) throw new Error('conversation_deleted');
    const history = new Map((this.db.prepare(`SELECT turn_id, body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' ORDER BY sequence`)
      .all(accountId, conversationId) as { turn_id: string; body_json: string }[])
      .map(row => [row.turn_id, JSON.parse(row.body_json) as Record<string, unknown> & { id: string }]));
    const ids = new Set(events.filter(e => e.kind === 'turn_started' && e.turnId).map(e => e.turnId!));
    for (const id of history.keys()) ids.add(id);
    const full = (ref: unknown): string | null => {
      if (!ref || typeof ref !== 'object') return null;
      const value = ref as { hash?: string; byteLength?: number };
      if (!value.hash || !Number.isSafeInteger(value.byteLength) || value.byteLength! < 0) return null;
      const chunks: string[] = []; let offset = 0;
      do {
        const chunk = model.content(accountId, conversationId, value.hash, offset, 64 * 1024);
        if (!chunk || chunk.byteLength !== value.byteLength || (chunk.nextOffset <= offset && offset < value.byteLength!)) return null;
        chunks.push(chunk.text); offset = chunk.nextOffset;
      } while (offset < value.byteLength!);
      const text = chunks.join('');
      return digest(text).hash === value.hash && Buffer.byteLength(text) === value.byteLength ? text : null;
    };
    return [...ids].map(turnId => {
      const old = history.get(turnId);
      const starts = events.filter(e => e.turnId === turnId && e.kind === 'turn_started');
      const endings = events.filter(e => e.turnId === turnId && e.kind === 'final_answer');
      const start: GatewayEventEnvelope = starts[0] ?? { accountId, conversationId, turnId, eventId: '', sequence: 0,
        requestId: null, protocolVersion: 2, kind: 'turn_started', occurredAt: String(old?.startedAt ?? ''), payload: {} };
      const ending = endings.at(-1);
      const inputs: { text: string; source: string }[] = [];
      const evidence: CandidateEvidence[] = [];
      for (const event of starts) {
        const payload = event.payload as Record<string, unknown>;
        const text = full(payload.userInputRef);
        if (text !== null) {
          evidence.push({ source: 'gateway_body', ...digest(text) });
          // Older Gateway refs can point to redacted publicText. A hash proves
          // integrity, not that the bytes are the original user input.
          if (payload.originalInputHash === digest(text).hash || payload.inputProvenance === 'original') {
            inputs.push({ text, source: 'original_gateway_body' });
          }
        }
      }
      if (start.requestId) {
        for (const row of this.db.prepare(`SELECT body_json FROM gateway_command_admissions WHERE account_id = ?
          AND json_extract(body_json, '$.conversationId') = ? AND json_extract(body_json, '$.requestId') = ?`)
          .all(accountId, conversationId, start.requestId) as { body_json: string }[]) {
          const admission = JSON.parse(row.body_json) as { command?: { kind?: string; text?: string }; commandTextRef?: string };
          if (admission.command?.kind === 'user_message' && typeof admission.command.text === 'string') {
            const text = admission.commandTextRef ? resolveDerivedContent(this.db, admission.commandTextRef) : admission.command.text;
            inputs.push({ text, source: 'original_gateway_admission' });
          }
        }
      }
      for (const row of this.db.prepare(`SELECT user_input, input_hash FROM planner_proposal_turns
        WHERE source_turn_id = ? AND session_id IN (SELECT json_extract(metadata_json, '$.plannerSessionId')
          FROM conversation_metadata_projection WHERE account_id = ? AND conversation_id = ?)`)
        .all(turnId, accountId, conversationId) as { user_input: string; input_hash: string | null }[]) {
        if (row.input_hash && digest(row.user_input).hash === row.input_hash) inputs.push({ text: row.user_input, source: 'planner_original_hash' });
      }
      if (old?.inputProvenance === 'original' && typeof old.userInput === 'string' && old.inputHash === digest(old.userInput).hash) {
        inputs.push({ text: old.userInput, source: 'canonical_original_hash' });
      }
      for (const input of inputs) evidence.push({ source: input.source, ...digest(input.text) });
      const input = inputs[0]?.text ?? null;
      const view = model.findTurn(accountId, conversationId, turnId);
      const answer = ending ? full((ending.payload as { answerRef?: unknown }).answerRef ?? view?.answerRef)
        : old?.answerProvenance === 'final_answer' && typeof old.finalAnswer === 'string'
          && old.answerHash === digest(old.finalAnswer).hash ? old.finalAnswer : null;
      if (answer !== null) evidence.push({ source: 'final_answer', ...digest(answer) });
      const inputHash = input === null ? null : digest(input).hash;
      const answerHash = answer === null ? null : digest(answer).hash;
      const finalHash = (ending?.payload as { contentHash?: string } | undefined)?.contentHash?.replace(/^sha256:/, '');
      const conflict = inputs.some(v => digest(v.text).hash !== inputHash) || Boolean(finalHash && answerHash && finalHash !== answerHash);
      const missing = input === null || !start.occurredAt || Boolean((ending || old?.finalAnswer) && answer === null);
      const existing = store.find({ accountId, conversationId, turnId });
      if (existing) { store.readBody(accountId, existing.input.hash); if (existing.answer) store.readBody(accountId, existing.answer.hash); }
      const report: TurnMigrationReport = { turnId, classification: existing ? 'exact_match' : conflict ? 'conflict'
        : missing ? 'missing' : 'recoverable_single_source', inputHash: existing?.input.hash ?? inputHash,
        answerHash: existing?.answer?.hash ?? answerHash, candidates: evidence,
        reason: existing ? 'already_authoritative' : conflict ? 'conflicting_verified_sources'
          : input === null ? 'original_input_provenance_unavailable' : missing ? 'complete_answer_or_timestamp_unavailable' : 'verified_original_content' };
      return { report, input: existing ? null : input, answer, start,
        end: ending ?? (answer === null ? null : { ...start, kind: 'final_answer' as const, occurredAt: String(old?.completedAt ?? start.occurredAt) }),
        taskId: typeof old?.taskId === 'string' ? old.taskId : null, history: old };
    }).sort((a, b) => a.start.occurredAt.localeCompare(b.start.occurredAt) || a.start.sequence - b.start.sequence);
  }
}
