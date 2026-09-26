/**
 * Account-scoped Planner Worker for durable Replan Jobs
 * (2026-09-25 Task lifecycle state convergence plan §5).
 *
 * The Kernel only authorizes a durable Replan Job (`schedule_replan`). This
 * worker is the sole consumer of a scheduled Job: it claims the Job with a
 * bounded Planner lease, performs one Planner turn, and submits the resulting
 * `plan_proposed` through the normal Kernel ingress. It runs on the account
 * periodic review, so no foreground TUI, Web connection or ConversationSession
 * callback is required for a replan to converge.
 *
 * Idempotency: the Job id is deterministic, the claim is a single conditional
 * UPDATE, and the proposal event is inserted together with the `submitted`
 * transition. A duplicate recovery pass therefore cannot create a second
 * Planner turn, and a proposed graph is accepted only through the existing
 * proposal identity and Kernel validation path.
 *
 * Planner unavailability is bounded: a transport or process failure releases the
 * claim with backoff, and once the retry budget is exhausted the Job fails
 * closed as `planner_unavailable` so the Kernel can authorize an explicit
 * `block_work` instead of leaving the Task permanently `running`.
 */

import { randomUUID } from 'node:crypto';
import type { Task } from '../core/types.js';
import type { KernelEvent } from '../kernel/control-kernel.js';
import type { ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import type { TaskEvidenceRecord } from '../execution/execution-evidence-port.js';
import type { PlanningContext, PlanningAgentPlan } from '../planning/planning-types.js';
import type {
  GenerationReplanRequestRecord,
  GenerationReplanRequestRepo,
} from '../storage/generation-replan-request-repo.js';

/** Planner-side port. Every fact is read from durable storage, never from a live session. */
export interface GenerationReplanPlannerPort {
  plan(context: PlanningContext): Promise<PlanningAgentPlan>;
  buildPlanningContext(input: {
    sessionId: string;
    conversationId: string | null;
    userInput: string;
  }): PlanningContext;
  materializeCompletedEvidence(taskId: string, revision: number): void;
  listTaskEvidence(taskId: string, generationId: string): readonly TaskEvidenceRecord[];
  listAttemptReceipts(taskId: string): readonly ExecutorAttemptReceipt[];
  /** Attachment ids the originating admission was admitted with. */
  resolveTurnAttachmentIds(taskId: string): readonly string[];
  /**
   * Reads a proposal this Job already produced. The proposal event id is
   * derived from the Job's trigger Decision, so a crash between the Planner
   * turn and the `submitted` transition is recoverable without a second Planner
   * turn (2026-09-25 review fix 5).
   */
  findPersistedProposal(eventId: string): Extract<KernelEvent, { type: 'plan_proposed' }> | null;
  /**
   * Drains the Kernel inbox for the originating Conversation inside the system
   * binding. The proposal event is already durable before this is called, so a
   * crash or a rejected drain is recovered by the normal Kernel recovery sweep.
   */
  drainKernel(input: {
    sessionId: string;
    conversationId: string | null;
    userInput: string;
    event: Extract<KernelEvent, { type: 'plan_proposed' }>;
  }): Promise<void>;
}

export interface GenerationReplanWorkerDeps {
  readonly replanRepo: GenerationReplanRequestRepo;
  readonly planner: GenerationReplanPlannerPort;
  findTask(taskId: string): Task | null;
  now(): string;
  /** A Planner claim older than this is treated as abandoned and re-claimable. */
  plannerLeaseMs?: number;
  /** Minimum delay before a failed Planner turn may be retried. */
  plannerRetryBackoffMs?: number;
  /** Absolute retry budget; past it the Job fails closed as `planner_unavailable`. */
  plannerRetryBudgetMs?: number;
  maxJobsPerPass?: number;
}

export interface GenerationReplanWorkerReport {
  readonly claimed: number;
  readonly submitted: number;
  readonly retried: number;
  readonly failed: number;
}

const DEFAULT_PLANNER_LEASE_MS = 10 * 60_000;
const DEFAULT_PLANNER_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_PLANNER_RETRY_BUDGET_MS = 30 * 60_000;
const DEFAULT_MAX_JOBS_PER_PASS = 5;
const MAX_ERROR_SUMMARY = 320;

export class GenerationReplanWorker {
  constructor(private readonly deps: GenerationReplanWorkerDeps) {}

  /**
   * Runs one bounded pass over scheduled Replan Jobs. A per-Job Planner failure
   * never throws: it either resechedules the same Job with backoff or fails it
   * closed as `planner_unavailable`, which is the convergent path required by
   * plan §5.2.
   */
  async run(): Promise<GenerationReplanWorkerReport> {
    const nowMs = Date.parse(this.deps.now());
    const leaseCutoff = new Date(
      nowMs - (this.deps.plannerLeaseMs ?? DEFAULT_PLANNER_LEASE_MS),
    ).toISOString();
    const retryNotBefore = new Date(
      nowMs - (this.deps.plannerRetryBackoffMs ?? DEFAULT_PLANNER_RETRY_BACKOFF_MS),
    ).toISOString();
    const jobs = this.deps.replanRepo.listPlannerClaimable(
      leaseCutoff,
      retryNotBefore,
      this.deps.maxJobsPerPass ?? DEFAULT_MAX_JOBS_PER_PASS,
    );
    let claimed = 0;
    let submitted = 0;
    let retried = 0;
    let failed = 0;
    for (const job of jobs) {
      // The claim token fences every later write for this Job: a worker whose
      // lease expired while another worker re-claimed cannot land a second
      // proposal or a second `submitted` transition.
      const claimToken = `${this.deps.now()}_${randomUUID()}`;
      if (!this.deps.replanRepo.claimForPlanner(job.id, this.deps.now(), leaseCutoff, claimToken)) {
        continue;
      }
      claimed += 1;
      const outcome = await this.consume(job, nowMs, claimToken);
      if (outcome === 'submitted') submitted += 1;
      else if (outcome === 'failed') failed += 1;
      else retried += 1;
    }
    return { claimed, submitted, retried, failed };
  }

  private async consume(
    job: GenerationReplanRequestRecord,
    nowMs: number,
    claimToken: string,
  ): Promise<'submitted' | 'retry' | 'failed'> {
    const budgetMs = this.deps.plannerRetryBudgetMs ?? DEFAULT_PLANNER_RETRY_BUDGET_MS;
    if (nowMs - Date.parse(job.createdAt) > budgetMs) {
      this.deps.replanRepo.fail(
        job.id,
        `planner_unavailable: the authorized Replan Job exceeded its ${budgetMs}ms retry budget`,
        this.deps.now(),
      );
      return 'failed';
    }
    const task = this.deps.findTask(job.taskId);
    if (!task) {
      this.deps.replanRepo.fail(job.id, `replan Task no longer exists: ${job.taskId}`, this.deps.now());
      return 'failed';
    }
    const sessionId = task.ownerPlannerSessionId ?? task.conversationId ?? null;
    if (!sessionId || !job.quiescenceToken) {
      this.deps.replanRepo.fail(
        job.id,
        `replan Job ${job.id} is missing its immutable Planner owner or quiescence token`,
        this.deps.now(),
      );
      return 'failed';
    }
    const conversationId = task.conversationId ?? null;
    const eventId = generationReplanProposalEventId(job);
    try {
      // A proposal this Job already produced is the recoverable Planner turn.
      // Re-planning it would be a second turn with a different result
      // (2026-09-25 review fix 5).
      const recovered = this.deps.planner.findPersistedProposal(eventId);
      if (recovered) {
        // The Planner turn is already durable for this Job; only the fenced
        // `submitted` transition is missing.
        if (!this.deps.replanRepo.completePlannerTurn({
          id: job.id,
          claimToken,
          now: this.deps.now(),
        })) {
          // Another worker owns or already finished this Job.
          return 'submitted';
        }
        await this.safeDrain({
          sessionId,
          conversationId,
          userInput: recovered.requestText,
          event: recovered,
        });
        return 'submitted';
      }
      const userInput = this.buildRequestText(job, task);
      const context = this.deps.planner.buildPlanningContext({
        sessionId,
        conversationId,
        userInput,
      });
      // The Job is pinned to the configuration revision that authorized its
      // generation. Replanning it against a different revision would silently
      // break the one-revision-per-generation rule, so fail closed instead.
      if (job.configurationRevision !== context.configuration.revisionId) {
        this.deps.replanRepo.fail(
          job.id,
          `configuration_revision_changed: Job ${job.id} is pinned to `
            + `${job.configurationRevision} but the current Planner revision is `
            + `${context.configuration.revisionId}`,
          this.deps.now(),
        );
        return 'failed';
      }
      const plan = await this.deps.planner.plan(context);
      const event = buildGenerationReplanProposedEvent({
        configurationRevision: context.configuration.revisionId,
        sessionId,
        conversationId,
        attachmentIds: this.deps.planner.resolveTurnAttachmentIds(task.id),
        plan,
        eventId,
        correlationId: job.id,
        causationId: job.triggerDecisionId,
        taskId: task.id,
        requestText: userInput,
        generationId: job.generationId,
        targetGraphRevision: job.sourceRevision + 1,
      });
      // Persist the proposal and mark the turn submitted in one fenced
      // transaction: a crash in between leaves a recoverable proposal, and a
      // lost claim cannot land anything.
      const submitted = this.deps.replanRepo.submitPlannerProposal({
        id: job.id,
        claimToken,
        event,
        now: this.deps.now(),
      });
      if (!submitted) {
        // The claim was fenced out; the owning worker lands the proposal.
        return 'submitted';
      }
      await this.safeDrain({ sessionId, conversationId, userInput, event });
      return 'submitted';
    } catch (error) {
      this.deps.replanRepo.releasePlannerClaim(job.id, boundedError(error), this.deps.now());
      return 'retry';
    }
  }

  private async safeDrain(input: {
    sessionId: string;
    conversationId: string | null;
    userInput: string;
    event: Extract<KernelEvent, { type: 'plan_proposed' }>;
  }): Promise<void> {
    try {
      await this.deps.planner.drainKernel(input);
    } catch {
      // The proposal event is already durable; the Kernel recovery sweep owns
      // the remaining drain. This is not a Planner failure.
    }
  }

  private buildRequestText(job: GenerationReplanRequestRecord, task: Task): string {
    this.deps.planner.materializeCompletedEvidence(task.id, job.sourceRevision);
    const evidence = this.deps.planner.listTaskEvidence(task.id, job.generationId);
    const failures = this.deps.planner.listAttemptReceipts(task.id)
      .filter(item => (
        item.generationId === job.generationId
        && item.graphRevision === job.sourceRevision
        && item.terminalState !== 'completed'
      ))
      .sort((left, right) => (
        left.completedAt.localeCompare(right.completedAt)
        || left.attemptId.localeCompare(right.attemptId)
      ));
    return buildGenerationReplanRequestText({
      taskId: task.id,
      taskGoal: task.goal,
      generationId: job.generationId,
      sourceRevision: job.sourceRevision,
      evidence,
      failures,
    });
  }
}

/**
 * Deterministic proposal event id for one Replan Job. It is the durable
 * Planner-turn identity, so a lookup by this id answers "did this Job already
 * produce a proposal".
 */
export function generationReplanProposalEventId(job: {
  triggerDecisionId: string;
}): string {
  return `replan_event_${job.triggerDecisionId}`;
}

/**
 * The only place the automatic replan request text is constructed. It is pure,
 * so the account-scoped worker and any foreground fast path produce the same
 * prompt for the same durable facts.
 */
export function buildGenerationReplanRequestText(input: {
  taskId: string;
  taskGoal: string;
  generationId: string;
  sourceRevision: number;
  evidence: readonly Pick<TaskEvidenceRecord, 'id' | 'title' | 'content'>[];
  failures: readonly Pick<
    ExecutorAttemptReceipt,
    'attemptId' | 'agentClassName' | 'terminalState' | 'failure' | 'errorCode' | 'errorDetail'
  >[];
}): string {
  return [
    'Produce a replan for the remaining work of the existing Task. Return plan_work_graph only.',
    `Task id: ${input.taskId}`,
    `Task goal: ${input.taskGoal}`,
    `Generation: ${input.generationId}`,
    `Superseded revision: ${input.sourceRevision}`,
    'The new graph must describe only remaining work and may reference the task_evidence IDs below.',
    'Do not bind the remaining work back to an Executor candidate that already failed in this generation unless you explain why this attempt would behave differently.',
    `Completed evidence: ${JSON.stringify(input.evidence.map(item => ({
      evidenceId: item.id,
      title: item.title,
      summary: item.content.slice(0, 2_000),
    })))}`,
    `Structured failures and attempted candidates: ${JSON.stringify(input.failures.map(item => ({
      attemptId: item.attemptId,
      agentClassName: item.agentClassName,
      terminalState: item.terminalState,
      failure: item.failure,
      code: item.errorCode,
      summary: String(item.errorDetail ?? '').slice(0, 1_000),
    })))}`,
    'Bind the proposal to the exact existing Task id. Do not include raw Executor responses.',
  ].join('\n\n').slice(0, 24_000);
}

export function buildGenerationReplanProposedEvent(input: {
  configurationRevision: string;
  sessionId: string;
  conversationId: string | null;
  attachmentIds: readonly string[];
  plan: PlanningAgentPlan;
  eventId: string;
  correlationId: string;
  causationId: string | null;
  taskId: string;
  requestText: string;
  generationId: string;
  targetGraphRevision: number;
}): Extract<KernelEvent, { type: 'plan_proposed' }> {
  return {
    schemaVersion: 5,
    configurationRevision: input.configurationRevision,
    type: 'plan_proposed',
    id: input.eventId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: new Date().toISOString(),
    sessionId: input.sessionId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    taskId: input.taskId,
    proposal: input.plan,
    requestText: input.requestText.slice(0, 24_000),
    generationId: input.generationId,
    proposalSource: 'replan',
    targetGraphRevision: input.targetGraphRevision,
    attachmentIds: [...input.attachmentIds],
    availabilityExplanation: null,
  };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_SUMMARY);
}
