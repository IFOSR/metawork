/**
 * Edge handoff materialization (ADR-0021 completion contract).
 *
 * A Subtask that becomes `done` owes every outgoing Work Graph edge a durable
 * handoff row: downstream Executors may only read upstream work through it, and
 * Kernel dispatch admission refuses to run a node whose dependency is `done`
 * but has no handoff. That makes "done" and "the edge handoff exists" one
 * invariant, so the write must sit on the completion boundary — the single
 * place that turns an attempt into `done` — and not on the publication path,
 * which no longer runs for in-place execution.
 *
 * The write is idempotent: `subtask_handoffs` is keyed by
 * `(task_id, from_subtask_id, to_subtask_id)` and immutable, so a replayed
 * completion or a legacy publication worker converges to the same row.
 */

import { createHash } from 'node:crypto';
import type { Subtask } from '../core/types.js';
import type { CompletionHandoffV4 } from './completion-protocol.js';
import type {
  PersistedSubtaskHandoff,
  PersistedSubtaskHandoffItem,
} from '../storage/subtask-handoff-repo.js';
import type { ResultReferenceRecord } from '../storage/result-object-repo.js';

/** The completion boundary cannot materialize a declared outgoing edge. */
export class EdgeHandoffMaterializationError extends Error {
  readonly code = 'edge_handoff_materialization_failed';

  constructor(
    readonly taskId: string,
    readonly subtaskId: string,
    detail: string,
  ) {
    super(`outgoing edge handoff cannot be materialized for ${subtaskId}: ${detail}`);
    this.name = 'EdgeHandoffMaterializationError';
  }
}

export interface EdgeHandoffTarget {
  readonly toSubtaskId: string;
  readonly requiredKeys: readonly string[];
  readonly requiredTypes: readonly string[];
}

export interface EdgeHandoffContext {
  readonly taskId: string;
  readonly subtaskId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly completionSchemaVersion: number;
  /** Handoffs the completion envelope declared explicitly, per target. */
  readonly declaredHandoffs: readonly CompletionHandoffV4[];
}

/** A safe body the edge handoff points at; null when no body was persisted. */
export interface EdgeHandoffSafeProjection {
  readonly resultId: string;
  readonly byteLength: number;
}

export interface EdgeHandoffMaterializerDeps {
  readonly accountId?: string;
  readonly subtaskRepo: { listByTask(taskId: string): readonly Subtask[] };
  readonly handoffRepo: {
    listByTask(taskId: string): readonly PersistedSubtaskHandoff[];
    insert(handoff: PersistedSubtaskHandoff): void;
  };
  readonly results: {
    findReference(referenceId: string): ResultReferenceRecord | null;
    createReference(input: {
      referenceId: string;
      resultId: string;
      accountId: string;
      taskId: string;
      generationId: string;
      sourceSubtaskId: string;
      targetSubtaskId: string;
      edgeKey: string;
      requiredItems: string[];
      readScope: ResultReferenceRecord['readScope'];
      createdAt?: string;
    }): ResultReferenceRecord;
  };
}

/** Every unresolved outgoing edge of one Subtask, in graph order. */
export function outgoingHandoffTargets(
  subtaskRepo: { listByTask(taskId: string): readonly Subtask[] },
  taskId: string,
  subtaskId: string,
): EdgeHandoffTarget[] {
  return subtaskRepo.listByTask(taskId).flatMap(candidate => candidate.dependencies
    .filter(dependency => dependency.fromSubtaskId === subtaskId)
    .map(dependency => ({
      toSubtaskId: candidate.id,
      requiredKeys: dependency.requiredItems.map(item => item.key),
      requiredTypes: dependency.requiredItems.map(item => item.type),
    })));
}

/**
 * Fails fast before the completion transaction when an outgoing edge exists but
 * no safe body can carry it. Silent success here is what leaves a Task with a
 * completed upstream node and a downstream node that can never be dispatched.
 */
export function assertEdgeHandoffsMaterializable(
  deps: Pick<EdgeHandoffMaterializerDeps, 'subtaskRepo'>,
  context: Pick<EdgeHandoffContext, 'taskId' | 'subtaskId'>,
  safeProjection: EdgeHandoffSafeProjection | null,
): void {
  const targets = outgoingHandoffTargets(deps.subtaskRepo, context.taskId, context.subtaskId);
  if (targets.length === 0) return;
  if (!safeProjection) {
    throw new EdgeHandoffMaterializationError(
      context.taskId,
      context.subtaskId,
      'the certified result has no safe body to hand to the dependent Subtasks',
    );
  }
}

/**
 * Writes the missing handoff rows for one Subtask. Idempotent and safe to call
 * from both the completion boundary and the legacy publication path.
 */
export function materializeOutgoingHandoffs(
  deps: EdgeHandoffMaterializerDeps,
  context: EdgeHandoffContext,
  safeProjection: EdgeHandoffSafeProjection | null,
  now: string,
): number {
  const targets = outgoingHandoffTargets(deps.subtaskRepo, context.taskId, context.subtaskId);
  if (targets.length === 0) return 0;
  assertEdgeHandoffsMaterializable(deps, context, safeProjection);
  const projection = safeProjection!;
  const existing = new Set(
    deps.handoffRepo.listByTask(context.taskId)
      .filter(handoff => handoff.fromSubtaskId === context.subtaskId)
      .map(handoff => handoff.toSubtaskId),
  );
  const accountId = deps.accountId ?? 'local-default';
  let inserted = 0;
  for (const target of targets) {
    if (existing.has(target.toSubtaskId)) continue;
    const declared = context.declaredHandoffs.find(handoff => handoff.toSubtaskId === target.toSubtaskId);
    const keys = declared && declared.items.length > 0
      ? declared.items.map(item => item.key)
      : target.requiredKeys.length > 0 ? [...target.requiredKeys] : ['result'];
    const summaryItems = (declared?.items ?? []).map(item => (
      item.type === 'text'
        ? { key: item.key, type: 'text' as const, summary: `Authorized upstream result for ${item.key}` }
        : { key: item.key, type: item.type, paths: [...item.paths] }
    ));
    const artifactItems = (declared?.items ?? []).map(item => (
      item.type === 'text'
        ? null
        : { key: item.key, type: 'artifact' as const, paths: [...item.paths] }
    ));
    const fallbackItems = keys.map(key => ({
      key,
      type: 'text' as const,
      summary: `Authorized upstream result for ${key}`,
    }));
    const effectiveSummary = declared && summaryItems.length > 0 ? summaryItems : fallbackItems;
    const effectiveArtifacts: Array<{ key: string; type: 'artifact'; paths: string[] } | null> =
      declared && summaryItems.length > 0 ? artifactItems : keys.map(() => null);
    insertEdgeHandoff(deps, {
      accountId,
      context,
      toSubtaskId: target.toSubtaskId,
      requiredKeys: keys,
      summaryItems: effectiveSummary,
      artifactItems: effectiveArtifacts,
      safeProjection: projection,
      now,
    });
    existing.add(target.toSubtaskId);
    inserted += 1;
  }
  return inserted;
}

function insertEdgeHandoff(
  deps: EdgeHandoffMaterializerDeps,
  input: {
    accountId: string;
    context: EdgeHandoffContext;
    toSubtaskId: string;
    requiredKeys: string[];
    summaryItems: Array<{ key: string; type: string; summary?: string; paths?: string[] }>;
    artifactItems: Array<{ key: string; type: 'artifact'; paths: string[] } | null>;
    safeProjection: EdgeHandoffSafeProjection;
    now: string;
  },
): void {
  const summaryHash = `sha256:${createHash('sha256')
    .update(JSON.stringify(input.summaryItems))
    .digest('hex')}`;
  const referenceId = resultReferenceId({
    accountId: input.accountId,
    taskId: input.context.taskId,
    generationId: input.context.generationId,
    sourceSubtaskId: input.context.subtaskId,
    targetSubtaskId: input.toSubtaskId,
    attemptId: input.context.attemptId,
    resultId: input.safeProjection.resultId,
  });
  // `result_references` is insert-only; a replayed completion reuses the row.
  const reference = deps.results.findReference(referenceId) ?? deps.results.createReference({
    referenceId,
    resultId: input.safeProjection.resultId,
    accountId: input.accountId,
    taskId: input.context.taskId,
    generationId: input.context.generationId,
    sourceSubtaskId: input.context.subtaskId,
    targetSubtaskId: input.toSubtaskId,
    edgeKey: `${input.context.subtaskId}->${input.toSubtaskId}`,
    requiredItems: input.requiredKeys,
    readScope: {
      kind: 'direct_dependency',
      offset: 0,
      length: input.safeProjection.byteLength,
      summaryHash,
    },
    createdAt: input.now,
  });
  const items: PersistedSubtaskHandoffItem[] = input.summaryItems.map((item, index) => {
    const artifact = input.artifactItems[index] ?? null;
    return artifact ?? {
      key: item.key,
      type: 'result_reference' as const,
      referenceId,
      summary: item.summary ?? `Authorized upstream result for ${item.key}`,
    };
  });
  deps.handoffRepo.insert({
    taskId: input.context.taskId,
    fromSubtaskId: input.context.subtaskId,
    toSubtaskId: input.toSubtaskId,
    attemptId: input.context.attemptId,
    items,
    resultReference: reference,
    completionSchemaVersion: input.context.completionSchemaVersion,
    createdAt: input.now,
  });
}

/** Deterministic reference identity; identical inputs never fork a reference. */
export function resultReferenceId(input: {
  accountId: string;
  taskId: string;
  generationId: string;
  sourceSubtaskId: string;
  targetSubtaskId: string;
  attemptId: string;
  resultId: string;
}): string {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  return `result_reference_${hash}`;
}
