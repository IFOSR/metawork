import { allowsProduction } from '../control/production-authorization.js';
/**
 * Account worker for durable replan proposals. A fenced Manager claim saves its
 * exact output and the Job's submitted transition in one transaction. Pending
 * proposal delivery is retried independently of the model-turn retry budget.
 */

import { randomUUID } from 'node:crypto';
import type { Task } from '../core/types.js';
import type { PlanAdmissionRequest } from '../execution/plan-admission-policy.js';
import { PlanProposalUnavailableError, type PlanProposalRecord } from '../execution/plan-proposal-store.js';
import { isTerminalTaskStatus } from '../task/task-state.js';
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
  /** Current durable graph, read before and after model IO and before delivery. */
  findActiveGraph(taskId: string): { generationId: string; revision: number; configurationRevision: string } | null;
  /** Acknowledges only after the receiving admission queue is durable. */
  submitProposal(input: {
    sessionId: string;
    conversationId: string | null;
    userInput: string;
    proposal: PlanAdmissionRequest;
    replanRequestId: string;
    triggerOperationId: string;
  }): Promise<void>;
}

export interface GenerationReplanWorkerDeps {
  productionAuthorization?: () => { allowed: boolean; reason?: string };
  readonly replanRepo: GenerationReplanRequestRepo;
  readonly planner: GenerationReplanPlannerPort;
  findTask(taskId: string): Task | null;
  /**
   * Admission facts for the Task's own Workspace. A replan continues an already
   * admitted Task, so admission must receive that Task's Workspace identity;
   * without it every automatic replan ends in "select a workspace".
   */
  resolveTaskWorkspace?(task: Task): { workspaceId: string; canonicalPath: string } | null;
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
    if (!allowsProduction(this.deps.productionAuthorization?.())) return { claimed: 0, submitted: 0, retried: 0, failed: 0 };
    const maxJobs = this.deps.maxJobsPerPass ?? DEFAULT_MAX_JOBS_PER_PASS;
    for (const saved of this.deps.replanRepo.proposals.listPendingReplans(maxJobs)) {
      if (!allowsProduction(this.deps.productionAuthorization?.())) break;
      const job = this.deps.replanRepo.find(saved.replanRequestId!);
      if (job?.status === 'planning') continue; // Planner claim owns the missing submitted transition.
      await this.deliverProposal(saved);
    }
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
      if (!allowsProduction(this.deps.productionAuthorization?.())) break;
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
    const task = this.deps.findTask(job.taskId);
    if (!task) {
      this.deps.replanRepo.failPlannerClaim(
        job.id,
        claimToken,
        `replan Task no longer exists: ${job.taskId}`,
        this.deps.now(),
      );
      return 'failed';
    }
    const sessionId = task.ownerPlannerSessionId ?? task.conversationId ?? null;
    if (!sessionId || !job.quiescenceToken) {
      this.deps.replanRepo.failPlannerClaim(
        job.id,
        claimToken,
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
      const invalid = this.staleReason(job, task);
      if (invalid) {
        this.deps.replanRepo.failPlannerClaim(job.id, claimToken, invalid, this.deps.now());
        return 'failed';
      }
      const recovered = this.deps.replanRepo.proposals.findForReplan(job.id);
      if (recovered) {
        if (recovered.delivery === 'invalidated') {
          this.deps.replanRepo.failPlannerClaim(job.id, claimToken,
            recovered.deliveryReason ?? 'saved proposal invalidated', this.deps.now());
          return 'failed';
        }
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
        await this.deliverProposal(recovered);
        return 'submitted';
      }
      const budgetMs = this.deps.plannerRetryBudgetMs ?? DEFAULT_PLANNER_RETRY_BUDGET_MS;
      if (nowMs - Date.parse(job.createdAt) > budgetMs) {
        this.deps.replanRepo.failPlannerClaim(
          job.id,
          claimToken,
          `planner_unavailable: the authorized Replan Job exceeded its ${budgetMs}ms retry budget`,
          this.deps.now(),
        );
        return 'failed';
      }
      const userInput = this.buildRequestText(job, task);
      const context = this.deps.planner.buildPlanningContext({
        sessionId,
        conversationId,
        userInput,
      });
      context.replan = {
        taskId: task.id,
        taskEvidenceIds: this.deps.planner.listTaskEvidence(task.id, job.generationId).map(item => item.id),
      };
      // The Job is pinned to the configuration revision that authorized its
      // generation. Replanning it against a different revision would silently
      // break the one-revision-per-generation rule, so fail closed instead.
      if (job.configurationRevision !== context.configuration.revisionId) {
        this.deps.replanRepo.failPlannerClaim(
          job.id,
          claimToken,
          `configuration_revision_changed: Job ${job.id} is pinned to `
            + `${job.configurationRevision} but the current Planner revision is `
            + `${context.configuration.revisionId}`,
          this.deps.now(),
        );
        return 'failed';
      }
      const plan = await this.deps.planner.plan(context);
      const taskWorkspace = this.deps.resolveTaskWorkspace?.(task) ?? null;
      const proposal = buildGenerationReplanProposal({
        configurationRevision: context.configuration.revisionId,
        ...(taskWorkspace ? { workspaceAdmission: { targetWorkspace: taskWorkspace } } : {}),
        sessionId,
        conversationId,
        attachmentIds: this.deps.planner.resolveTurnAttachmentIds(task.id),
        plan,
        proposalId: eventId,
        taskId: task.id,
        requestText: userInput,
        generationId: job.generationId,
        targetGraphRevision: job.sourceRevision + 1,
      });
      // Persist the proposal and mark the turn submitted in one fenced
      // transaction: a crash in between leaves a recoverable proposal, and a
      // lost claim cannot land anything.
      const latestTask = this.deps.findTask(job.taskId);
      const stale = latestTask ? this.staleReason(job, latestTask) : 'replan Task no longer exists';
      const currentConfiguration = this.deps.planner.buildPlanningContext({ sessionId, conversationId, userInput }).configuration.revisionId;
      const ownerChanged = latestTask && (latestTask.conversationId !== task.conversationId
        || latestTask.ownerPlannerSessionId !== task.ownerPlannerSessionId || latestTask.workspaceId !== task.workspaceId);
      if (stale || ownerChanged || currentConfiguration !== job.configurationRevision) {
        this.deps.replanRepo.failPlannerClaim(job.id, claimToken,
          stale ?? (ownerChanged ? 'replan owner changed during Manager turn' : 'configuration_revision_changed during Manager turn'), this.deps.now());
        return 'failed';
      }
      const submitted = this.deps.replanRepo.submitPlannerProposal({
        id: job.id,
        claimToken,
        proposal,
        now: this.deps.now(),
      });
      if (!submitted) {
        // The claim was fenced out; the owning worker lands the proposal.
        return 'submitted';
      }
      const saved = this.deps.replanRepo.proposals.findForReplan(job.id);
      if (saved) await this.deliverProposal(saved);
      return 'submitted';
    } catch (error) {
      this.deps.replanRepo.releasePlannerClaim(
        job.id,
        claimToken,
        boundedError(error),
        this.deps.now(),
      );
      return 'retry';
    }
  }

  private staleReason(job: GenerationReplanRequestRecord, task: Task): string | null {
    if (isTerminalTaskStatus(task.status)) return `replan Task is terminal: ${task.status}`;
    const graph = this.deps.planner.findActiveGraph(job.taskId);
    if (!graph || graph.generationId !== job.generationId || graph.revision !== job.sourceRevision) return 'replan graph identity changed';
    if (graph.configurationRevision !== job.configurationRevision) return 'configuration_revision_changed in active graph';
    return null;
  }

  private async deliverProposal(saved: PlanProposalRecord): Promise<void> {
    if (saved.delivery !== 'pending' || !allowsProduction(this.deps.productionAuthorization?.())) return;
    const job = this.deps.replanRepo.find(saved.replanRequestId!);
    const task = job ? this.deps.findTask(job.taskId) : null;
    const request = saved.request;
    let invalid = !job || !task ? 'replan Job or Task no longer exists'
      : job.status !== 'submitted' ? `replan Job is ${job.status}`
      : this.staleReason(job, task);
    if (!invalid && task) {
      const owner = task.ownerPlannerSessionId ?? task.conversationId;
      if (owner !== request.sessionId || (task.conversationId ?? null) !== (request.conversationId ?? null)) {
        invalid = 'replan Conversation owner changed';
      }
      const workspaceId = request.workspaceAdmission?.targetWorkspace?.workspaceId;
      if (workspaceId && task.workspaceId !== workspaceId) invalid = 'replan Workspace owner changed';
    }
    if (invalid) {
      this.deps.replanRepo.invalidateSubmittedProposal(request.id, invalid, this.deps.now());
      return;
    }
    try {
      const configuration = this.deps.planner.buildPlanningContext({
        sessionId: request.sessionId, conversationId: request.conversationId ?? null, userInput: request.requestText,
      }).configuration.revisionId;
      if (configuration !== request.configurationRevision) {
        this.deps.replanRepo.invalidateSubmittedProposal(request.id, 'configuration_revision_changed before admission', this.deps.now());
        return;
      }
      await this.deps.planner.submitProposal({
        sessionId: request.sessionId, conversationId: request.conversationId ?? null,
        userInput: request.requestText, proposal: request,
        replanRequestId: saved.replanRequestId!, triggerOperationId: saved.triggerOperationId!,
      });
      this.deps.replanRepo.proposals.markForwarded(request.id, this.deps.now());
    } catch (error) {
      if (error instanceof PlanProposalUnavailableError) {
        this.deps.replanRepo.invalidateSubmittedProposal(request.id, error.code, this.deps.now());
        return;
      }
      // Durable input is pending. Retry delivery, never the Manager turn.
      this.deps.replanRepo.proposals.recordDeliveryFailure(request.id, this.deps.now());
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
    'Copy evidenceId strings exactly into task_evidence ContextRefs; never shorten or reconstruct an ID.',
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

export function buildGenerationReplanProposal(input: {
  configurationRevision: string;
  sessionId: string;
  conversationId: string | null;
  attachmentIds: readonly string[];
  plan: PlanningAgentPlan;
  proposalId: string;
  taskId: string;
  requestText: string;
  generationId: string;
  targetGraphRevision: number;
  workspaceAdmission?: { targetWorkspace: { workspaceId: string; canonicalPath: string } | null };
}): PlanAdmissionRequest {
  return {
    configurationRevision: input.configurationRevision,
    id: input.proposalId,
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
    ...(input.workspaceAdmission ? { workspaceAdmission: input.workspaceAdmission } : {}),
  };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_SUMMARY);
}
