import type Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Task } from '../core/types.js';
import type { ContextRef } from './types.js';
import { contextRefKey } from './validation.js';
import { hashContent } from '../storage/task-artifact-repo.js';

interface InteractionReferenceRow {
  id: string;
  task_id: string | null;
  session_id: string | null;
  system_output: string;
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
}): string[] {
  const eligible = new Set<string>();
  for (const ref of input.refs) {
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
    if (ref.kind === 'preference') {
      if (!input.db) continue;
      const row = input.db.prepare('SELECT status FROM preferences WHERE id = ?')
        .get(ref.preferenceId) as { status: string } | undefined;
      if (row?.status === 'confirmed') eligible.add(contextRefKey(ref));
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
  const row = input.db.prepare(`
    SELECT id, task_id, session_id, system_output
    FROM interactions WHERE id = ?
  `).get(input.ref.interactionId) as InteractionReferenceRow | undefined;
  if (!row || row.session_id !== input.sessionId) return false;
  if (input.targetTaskId && row.task_id !== input.targetTaskId) return false;
  if (input.ref.side === 'user') return true;
  return row.system_output.trim().length > 0;
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
