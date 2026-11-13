import type Database from 'better-sqlite3';
import type { Subtask, SubtaskStatus } from '../core/types.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ControlEvent } from '../control/control-contracts.js';
import {
  ExecutorAttemptReceiptRepo,
  type ExecutorAttemptReceiptInsert,
} from '../storage/executor-attempt-receipt-repo.js';
import { ControlDispatchItemRepo } from '../storage/dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import { SqliteResourceLeaseRepository } from '../storage/resource-lease-repo.js';
import type { CompletionHandoffV4 } from './completion-protocol.js';
import {
  EdgeHandoffMaterializationError,
  materializeOutgoingHandoffs,
  type EdgeHandoffMaterializerDeps,
  type EdgeHandoffSafeProjection,
} from './subtask-handoff-materializer.js';

type AttemptTerminalEvent =
  | (Omit<
      Extract<ControlEvent, { type: 'execution_outcome' }>,
      'configurationRevision' | 'authorizedBinding' | 'bindingFingerprint'
    > & {
      configurationRevision?: string;
      authorizedBinding?: AuthorizedExecutorBinding;
      bindingFingerprint?: string;
      agentClassName?: string;
    })
  | (Omit<
      Extract<ControlEvent, { type: 'handoff_contract_failed' }>,
      'configurationRevision' | 'authorizedBinding' | 'bindingFingerprint'
    > & {
      configurationRevision?: string;
      authorizedBinding?: AuthorizedExecutorBinding;
      bindingFingerprint?: string;
      agentClassName?: string;
    })
  | (Omit<
      Extract<ControlEvent, { type: 'execution_result_observed' }>,
      'configurationRevision' | 'authorizedBinding' | 'bindingFingerprint'
    > & {
      configurationRevision?: string;
      authorizedBinding?: AuthorizedExecutorBinding;
      bindingFingerprint?: string;
      agentClassName?: string;
    });

export interface AttemptTerminalLanding {
  /** Prepared Git/artifact facts; synchronous and committed with done + outgoing handoffs. */
  commitFacts?:()=>void;
  receipt: ExecutorAttemptReceiptInsert;
  expectedSubtaskStatus: SubtaskStatus;
  nextSubtaskStatus: SubtaskStatus;
  subtaskError: string | null;
  event: AttemptTerminalEvent;
  publication?: Parameters<WorkspacePublicationRepo['insertCandidate']>[0];
  repairPublication?: {
    publicationId: string;
    candidateCommit: string;
  };
  subtaskResult?: string;
  subtaskArtifacts?: string[];
  subtaskVerification?: Subtask['verification'];
  /** In-place execution lands the result directly; no publication row is created. */
  directCompletion?: boolean;
  /**
   * Outgoing edge handoffs this completion owes its dependent Subtasks. A Task
   * that becomes `done` must hand its result to every outgoing edge inside the
   * same transaction; otherwise the downstream node can never be dispatched.
   */
  edgeHandoffs?: {
    generationId: string;
    completionSchemaVersion: number;
    declaredHandoffs: readonly CompletionHandoffV4[];
    artifactVersions?: Readonly<Record<string, string>>;
    safeProjection: EdgeHandoffSafeProjection | null;
  };
  now: string;
}

export interface AttemptTerminalLandingResult {
  cancellationWon: boolean;
  /**
   * The normalized observation for the caller to apply on the Task's own control
   * loop. It is a return value, not an inbox row: the receipt committed in the
   * same transaction is the durable fact.
   */
  event: ControlEvent;
}

/**
 * Commits every durable database fact that makes one authorized attempt
 * terminal. Container, WorkUnit and resource-lease cleanup deliberately sits
 * outside this transaction and is resumed independently.
 */
export class AttemptTerminalService {
  private readonly receipts: ExecutorAttemptReceiptRepo;
  private readonly dispatchItems: ControlDispatchItemRepo;
  private readonly publications: WorkspacePublicationRepo;

  constructor(
    private readonly db: Database.Database,
    /** Absent only in recovery/test compositions that never land a completion. */
    private readonly handoffMaterializer?: EdgeHandoffMaterializerDeps,
  ) {
    this.receipts = new ExecutorAttemptReceiptRepo(db);
    this.dispatchItems = new ControlDispatchItemRepo(db);
    this.publications = new WorkspacePublicationRepo(db);
  }

  /** Recover a failed terminal write from durable process-exit and failure facts.
   * Never certify its output or rewind a Subtask completed by a later attempt.
   * Returns the original claim identity so startup can finish normal cleanup.
   */
  reconcileSettledFailure(attemptId: string, now: string): {
    attemptId: string; taskId: string; subtaskId: string; workUnitId: string;
  } | null {
    return this.db.transaction(() => {
      const dispatch = this.dispatchItems.find(attemptId);
      if (!dispatch || dispatch.status !== 'uncertain' || this.receipts.findByAttemptId(attemptId)) return null;
      const subtask = this.db.prepare('SELECT generation_id FROM subtasks WHERE id = ? AND task_id = ?')
        .get(dispatch.subtaskId, dispatch.taskId) as { generation_id: string } | undefined;
      if (subtask?.generation_id !== dispatch.generationId) return null;
      const runtime = new ExecutorAttemptRuntimeRepo(this.db).find(attemptId);
      const diagnostics = runtime?.progress.diagnostics as { process?: {
        startedAt?: string; completedAt?: string; exitCode?: number | null; signal?: string | null;
      } } | undefined;
      const process = diagnostics?.process;
      if (!runtime || runtime.recoverySafety === 'external_non_idempotent'
        || !process?.startedAt || !process.completedAt
        || !Number.isFinite(Date.parse(process.completedAt))
        || (typeof process.exitCode !== 'number' && !process.signal)) return null;
      // Owner facts only: the process exited and the effect is provably local.
      if (runtime.externalEffectStatus === 'unknown') return null;
      if (this.db.prepare(`SELECT 1 FROM attempt_sandboxes WHERE attempt_id = ?
        AND status IN ('created', 'running', 'paused') LIMIT 1`).get(attemptId)) return null;
      const owners = this.db.prepare(`SELECT DISTINCT work_unit_id FROM resource_leases
        WHERE attempt_id = ? AND task_id = ? AND subtask_id = ? AND generation_id = ?`)
        .all(attemptId, dispatch.taskId, dispatch.subtaskId, dispatch.generationId) as { work_unit_id: string }[];
      const ownerIds = new Set(owners.map(owner => owner.work_unit_id));
      if (dispatch.workUnitId) ownerIds.add(dispatch.workUnitId);
      if (ownerIds.size !== 1) return null;
      const workUnitId = [...ownerIds][0]!;
      const failure = {
        kind: 'infrastructure' as const,
        scope: 'attempt' as const,
        code: 'process_exit',
        summary: `execution backend exited without a terminal observation (code=${
          process.exitCode ?? 'null'}, signal=${process.signal ?? 'null'})`,
      };
      this.receipts.insert({
        attemptId, taskId: dispatch.taskId, subtaskId: dispatch.subtaskId, workUnitId,
        executionId: `reconciled_${attemptId}`, agentClassName: dispatch.authorizedBinding.agentClassRef,
        startedAt: process.startedAt, completedAt: process.completedAt,
        terminalState: 'executor_failed', rawResponse: '', completionSchemaVersion: null,
        parsing: { recoveredFromProcessExit: true },
        verification: { warnings: ['Recovered failed terminal write; no completion certified.'], violations: [] },
        errorCode: failure.code, errorDetail: failure.summary, failure,
      });
      this.dispatchItems.markTerminal(attemptId, failure.summary, now);
      new SqliteResourceLeaseRepository(this.db).releaseReconciledAttempt(attemptId, now);
      return { attemptId, taskId: dispatch.taskId, subtaskId: dispatch.subtaskId, workUnitId };
    }).immediate();
  }

  land(input: AttemptTerminalLanding): AttemptTerminalLandingResult {
    return this.db.transaction(() => {
      const dispatch = this.dispatchItems.find(input.receipt.attemptId);
      if (!dispatch) {
        throw new Error(`authorized dispatch item not found: ${input.receipt.attemptId}`);
      }
      if (
        dispatch.taskId !== input.receipt.taskId
        || dispatch.subtaskId !== input.receipt.subtaskId
        || input.event.attemptId !== input.receipt.attemptId
        || input.event.taskId !== input.receipt.taskId
        || input.event.subtaskId !== input.receipt.subtaskId
      ) {
        throw new Error(`attempt terminal identity mismatch: ${input.receipt.attemptId}`);
      }
      if (input.publication && input.repairPublication) {
        throw new Error(`attempt terminal cannot create and repair a publication: ${input.receipt.attemptId}`);
      }

      const fence = this.db.prepare(`
        SELECT tasks.status AS task_status, subtasks.status AS subtask_status
        FROM tasks
        INNER JOIN subtasks ON subtasks.id = ?
        WHERE tasks.id = ?
      `).get(input.receipt.subtaskId, input.receipt.taskId) as {
        task_status: string;
        subtask_status: SubtaskStatus;
      } | undefined;
      if (!fence) {
        throw new Error(`attempt terminal fence facts not found: ${input.receipt.attemptId}`);
      }
      const cancellationWon = fence.task_status === 'cancelled'
        || fence.subtask_status === 'cancelled'
        || dispatch.status === 'cancelling'
        || dispatch.status === 'cancelled';

      this.receipts.insert(input.receipt);
      // The receipt is the durable "no unknown external effect" fact; recording
      // it closes the uncertainty window for this Attempt.
      new ExecutorAttemptRuntimeRepo(this.db).recordReceiptPersisted(
        input.receipt.attemptId,
        input.now,
      );
      if (!cancellationWon) {
        input.commitFacts?.();
        const changed = this.db.prepare(`
          UPDATE subtasks
          SET status = ?,
              result = COALESCE(?, result),
              artifacts_json = COALESCE(?, artifacts_json),
              verification_json = COALESCE(?, verification_json),
              error = ?,
              updated_at = ?
          WHERE id = ? AND task_id = ? AND status = ?
            AND EXISTS (
              SELECT 1 FROM tasks
              WHERE tasks.id = subtasks.task_id AND tasks.status IN ('running', 'needs_action', 'queued')
            )
        `).run(
          input.directCompletion ? 'done' : input.nextSubtaskStatus,
          input.subtaskResult ?? null,
          input.subtaskArtifacts ? JSON.stringify(input.subtaskArtifacts) : null,
          input.subtaskVerification ? JSON.stringify(input.subtaskVerification) : null,
          input.subtaskError,
          input.now,
          input.receipt.subtaskId,
          input.receipt.taskId,
          input.expectedSubtaskStatus,
        ).changes;
        if (changed !== 1) {
          throw new Error(`attempt terminal fence changed: ${input.receipt.attemptId}`);
        }
        if (input.directCompletion && input.edgeHandoffs) {
          if (!this.handoffMaterializer) {
            throw new EdgeHandoffMaterializationError(
              input.receipt.taskId,
              input.receipt.subtaskId,
              'the completion boundary has no edge handoff writer configured',
            );
          }
          // Same transaction as the `done` transition: a completion that cannot
          // hand its result downstream must not be recorded as done.
          materializeOutgoingHandoffs(this.handoffMaterializer, {
            taskId: input.receipt.taskId,
            subtaskId: input.receipt.subtaskId,
            generationId: input.edgeHandoffs.generationId,
            attemptId: input.receipt.attemptId,
            completionSchemaVersion: input.edgeHandoffs.completionSchemaVersion,
            declaredHandoffs: input.edgeHandoffs.declaredHandoffs,
            artifactVersions: input.edgeHandoffs.artifactVersions,
          }, input.edgeHandoffs.safeProjection, input.now);
        }
        if (input.publication && !input.directCompletion) {
          this.publications.insertCandidate(input.publication);
        }
        if (input.repairPublication && !input.directCompletion) {
          this.publications.markPendingAfterRepair(
            input.repairPublication.publicationId,
            input.repairPublication.candidateCommit,
            input.now,
          );
          const repaired = this.db.prepare(`
            SELECT status, candidate_commit
            FROM workspace_publications
            WHERE id = ? AND task_id = ? AND subtask_id = ?
          `).get(
            input.repairPublication.publicationId,
            input.receipt.taskId,
            input.receipt.subtaskId,
          ) as { status: string; candidate_commit: string } | undefined;
          if (
            repaired?.status !== 'pending'
            || repaired.candidate_commit !== input.repairPublication.candidateCommit
          ) {
            throw new Error(`merge-repair publication did not become pending: ${input.receipt.attemptId}`);
          }
        }
      }

      this.dispatchItems.markTerminal(
        input.receipt.attemptId,
        input.receipt.errorDetail,
        input.now,
      );
      const terminalDispatch = this.dispatchItems.find(input.receipt.attemptId);
      if (!terminalDispatch || !['terminal', 'cancelled'].includes(terminalDispatch.status)) {
        throw new Error(`dispatch item did not become terminal: ${input.receipt.attemptId}`);
      }
      // The receipt inserted above is the durable outcome fact; the caller
      // applies the normalized observation on the Task's own control loop.
      const terminalEvent = materializeTerminalEvent(input.event, dispatch);
      const event: ControlEvent = cancellationWon && terminalEvent.type === 'execution_outcome'
        ? cancellationOutcome(terminalEvent, dispatch, input.now)
        : terminalEvent;
      return { cancellationWon, event };
    }).immediate();
  }
}

function cancellationOutcome(
  event: Extract<ControlEvent, { type: 'execution_outcome' }>,
  dispatch: NonNullable<ReturnType<ControlDispatchItemRepo['find']>>,
  now: string,
): ControlEvent {
  return {
    schemaVersion: 5,
    configurationRevision: dispatch.configurationRevision,
    type: 'execution_outcome',
    id: event.id,
    correlationId: dispatch.decisionId,
    causationId: dispatch.decisionId,
    occurredAt: now,
    sessionId: event.sessionId,
    taskId: dispatch.taskId,
    subtaskId: dispatch.subtaskId,
    attemptId: dispatch.attemptId,
    terminalKind: 'failed',
    authorizedBinding: dispatch.authorizedBinding,
    bindingFingerprint: dispatch.bindingFingerprint,
    attemptKind: dispatch.attemptKind,
    sourceAttemptId: dispatch.sourceAttemptId,
    failure: {
      kind: 'stale',
      scope: 'attempt',
      code: 'cancelled_or_stale',
      summary: 'Cancellation fence won before attempt terminal landing',
    },
  };
}

function materializeTerminalEvent(
  event: AttemptTerminalEvent,
  dispatch: NonNullable<ReturnType<ControlDispatchItemRepo['find']>>,
): Extract<ControlEvent, {
  type: 'execution_outcome' | 'handoff_contract_failed' | 'execution_result_observed';
}> {
  const {
    agentClassName: _agentClassName,
    configurationRevision: _configurationRevision,
    authorizedBinding: _authorizedBinding,
    bindingFingerprint: _bindingFingerprint,
    ...eventFacts
  } = event;
  return {
    ...eventFacts,
    configurationRevision: dispatch.configurationRevision,
    authorizedBinding: dispatch.authorizedBinding,
    bindingFingerprint: dispatch.bindingFingerprint,
  };
}
