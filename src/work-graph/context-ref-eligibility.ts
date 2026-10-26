import type Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { ContextRef } from './types.js';
import { contextRefKey } from './validation.js';
import { hashContent } from '../storage/task-artifact-repo.js';

const SUPPORTED_CONTEXT_REF_KINDS: ReadonlySet<string> = new Set([
  'current_user_input', 'interaction', 'attachment', 'artifact',
  'task_resource', 'task_evidence', 'memory',
]);

interface InteractionReferenceRow {
  id: string;
  session_id: string | null;
  user_input: string;
  system_output: string;
  created_at: string;
}

export class InteractionReferenceError extends Error {
  constructor(readonly code: 'interaction_source_missing' | 'interaction_not_authorized' | 'interaction_content_unavailable', interactionId: string) {
    super(`${code}: ${interactionId}`);
    this.name = 'InteractionReferenceError';
  }
}

/** The account database and trusted session scope are supplied by the application. */
export function readAuthorizedInteraction(input: {
  db: Database.Database;
  sessionId: string;
  interactionId: string;
  side: 'user' | 'assistant';
}): InteractionReferenceRow {
  const row = input.db.prepare(`
    SELECT id, session_id, user_input, system_output, created_at
    FROM interactions WHERE id = ?
  `).get(input.interactionId) as InteractionReferenceRow | undefined;
  if (!row) throw new InteractionReferenceError('interaction_source_missing', input.interactionId);
  if (row.session_id !== input.sessionId) {
    throw new InteractionReferenceError('interaction_not_authorized', input.interactionId);
  }
  if (input.side === 'assistant' && !row.system_output.trim()) {
    throw new InteractionReferenceError('interaction_content_unavailable', input.interactionId);
  }
  return row;
}

export function buildEligibleContextRefKeys(input: {
  db: Database.Database | null;
  sessionId: string;
  conversationId?: string;
  accountId?: string;
  workspaceId?: string;
  refs: ContextRef[];
  targetTask: Task | null;
  userInput: string;
  attachmentIds?: readonly string[];
}): string[] {
  const eligible = new Set<string>();
  for (const ref of input.refs) {
    // Persisted payloads can carry a retired kind (e.g. `preference`). They
    // must fail closed instead of being skipped or treated as an interaction.
    if (!SUPPORTED_CONTEXT_REF_KINDS.has((ref as { kind?: string }).kind ?? '')) {
      throw new Error(`context_ref_not_supported: ${(ref as { kind?: string }).kind ?? ''}`);
    }
    if (ref.kind === 'current_user_input') {
      eligible.add(contextRefKey(ref));
      continue;
    }
    if (ref.kind === 'task_resource') {
      if (input.targetTask?.resources.includes(ref.locator)
        || (!input.targetTask && input.userInput.includes(ref.locator))) {
        eligible.add(contextRefKey(ref));
      }
      continue;
    }
    if (ref.kind === 'attachment') {
      if (input.attachmentIds?.includes(ref.attachmentId)) {
        eligible.add(contextRefKey(ref));
      }
      continue;
    }
    if (ref.kind === 'artifact') {
      if (input.db && isEligibleArtifactRef({
        db: input.db,
        artifactId: ref.artifactId,
        accountId: input.accountId ?? input.targetTask?.accountId,
        conversationId: input.conversationId ?? input.targetTask?.conversationId,
        workspaceId: input.workspaceId ?? input.targetTask?.workspaceId,
      })) {
        eligible.add(contextRefKey(ref));
      }
      continue;
    }
    if (ref.kind === 'memory') {
      if (!input.db) continue;
      const accountId = input.accountId ?? input.targetTask?.accountId;
      if (!accountId) continue;
      // The account is the only isolation boundary; a disabled asset is not
      // eligible and can never be materialized into evidence.
      const row = input.db.prepare(
        'SELECT 1 FROM memory_bindings WHERE memory_id = ? AND account_id = ? AND enabled = 1',
      ).get(ref.memoryId, accountId);
      if (row) eligible.add(contextRefKey(ref));
      continue;
    }
    if (ref.kind === 'task_evidence') {
      if (!input.db) continue;
      const row = input.db.prepare(`
        SELECT id FROM task_execution_evidence
        WHERE id = ? AND task_id = ? AND kind = 'task_evidence'
      `).get(ref.evidenceId, input.targetTask?.id ?? '') as { id: string } | undefined;
      if (row) eligible.add(contextRefKey(ref));
      continue;
    }
    if (!input.db) continue;
    if (isEligibleInteractionRef({
      db: input.db,
      sessionId: input.sessionId,
      ref,
      targetTaskId: input.targetTask?.id ?? null,
      userInput: input.userInput,
    })) {
      eligible.add(contextRefKey(ref));
    }
  }
  return [...eligible];
}

export function isEligibleInteractionRef(input: {
  db: Database.Database;
  sessionId: string;
  ref: Extract<ContextRef, { kind: 'interaction' }>;
  targetTaskId: string | null;
  userInput: string;
}): boolean {
  try {
    readAuthorizedInteraction({
      db: input.db, sessionId: input.sessionId,
      interactionId: input.ref.interactionId, side: input.ref.side,
    });
    return true;
  } catch (error) {
    if (error instanceof InteractionReferenceError) return false;
    throw error;
  }
}

function isEligibleArtifactRef(input: {
  db: Database.Database;
  artifactId: string;
  accountId?: string;
  conversationId?: string;
  workspaceId?: string;
}): boolean {
  const row = input.db.prepare(`
    SELECT a.artifact_id, a.account_id, a.status,
           a.published_path, a.content_hash,
           t.conversation_id, t.workspace_id
    FROM task_artifacts a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.artifact_id = ?
  `).get(input.artifactId) as {
    artifact_id: string;
    account_id: string;
    status: string;
    published_path: string;
    content_hash: string;
    conversation_id: string | null;
    workspace_id: string | null;
  } | undefined;
  if (
    !row
    || row.status !== 'published'
    || !row.content_hash
    || !isAbsolute(row.published_path)
    || !isMaterializableArtifact(row.published_path, row.content_hash)
  ) return false;
  if (input.accountId && row.account_id !== input.accountId) return false;
  if (input.conversationId && row.conversation_id !== input.conversationId) return false;
  if (input.workspaceId && row.workspace_id !== input.workspaceId) return false;
  return true;
}

function isMaterializableArtifact(publishedPath: string, expectedHash: string): boolean {
  try {
    const info = lstatSync(publishedPath, { throwIfNoEntry: false });
    return Boolean(
      info?.isFile()
      && !info.isSymbolicLink()
      && hashContent(readFileSync(publishedPath)) === expectedHash,
    );
  } catch {
    return false;
  }
}
