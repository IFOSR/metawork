import type { LocalServiceOperation, LocalServiceSpecification } from '../task/local-service.js';
import { allowsControlAction, type ProductionAuthorizationFact } from './production-authorization.js';
import type {
  ControlConfigurationView,
  PlannerConfigurationView,
} from '../configuration/index.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { PlanningAgentPlan } from '../planning/planning-types.js';
import {
  type WorkspaceAdmission,
  type WorkspaceAdmissionTargetFact,
  type WorkspaceDeliveryPolicy,
  type WorkspaceExecutionDecision,
  type WorkspaceExecutionMode,
  type WorkspaceIntent,
} from '../core/workspace-execution.js';
import type { WorkGraphProposal } from '../work-graph/types.js';
import type { ControlExecutorStatusProjection } from './executor-status-projection.js';
import type { TaskStatus } from '../task/task-state.js';
import type { SpanRoutingObservation } from '../routing/span-routing-types.js';
import type { RoutingResolutionAudit } from '../routing/auto-model-resolver.js';
import type { ControlFailure } from '../core/kernel-failure.js';
import type {
  CapabilityGrant,
  NormalizedCapabilityRequest,
  PermissionRule,
  ResourceClaim,
} from '../resource/index.js';

/**
 * Control-loop transport contracts (ADR-0055 D6 renames these to owner
 * operation contracts). Policy lives in `src/execution/*-policy.ts`; this module
 * holds only the shared event/snapshot/operation shapes, the decision factory
 * and the authorization/snapshot guards.
 */
/** The six-state Task contract. Owned by the Task Domain and reused by Runtime policies. */
export type ControlTaskStatus = TaskStatus;
export type ControlSubtaskStatus = 'ready' | 'running' | 'awaiting_integration' | 'awaiting_decision' | 'blocked' | 'done' | 'cancelled';
export type ControlAttemptKind = 'primary' | 'continuation' | 'fallback' | 'contract_correction' | 'merge_repair';
export type ControlRecoveryMode = 'native_session' | 'recovery_packet' | 'fresh';
export type ControlResumeBlockerCategory =
  | 'capacity'
  | 'retry'
  | 'availability'
  | 'dependency_publication'
  | 'explicit_resource'
  | 'parked'
  | 'user_wait'
  | 'manual'
  | 'material'
  | 'contract'
  | 'unknown';
export type ControlRecoverySafety = 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';
export type ControlDispatchItemStatus =
  | 'pending_launch'
  | 'launching'
  | 'running'
  | 'cancelling'
  | 'terminal'
  | 'cancelled'
  | 'uncertain';

/**
 * How a `terminal` dispatch item stopped being active.
 *
 * `terminal` only means "this dispatch item no longer owns scheduler capacity".
 * It never implies the Attempt succeeded: success requires an immutable receipt
 * with `terminal_state = completed` (2026-10-28 transparent execution §P2.1).
 *
 * - `executed`: the Runtime reported an execution fact for the Attempt.
 * - `not_started`: the Attempt yielded before executing (resource partition,
 *   unavailable Executor). No receipt, runtime, work unit or duration exists.
 */
export type ControlDispatchTerminalDisposition = 'executed' | 'not_started';
export type ControlAttemptPayload =
  | {
      protocol: 'completion-correction-v2';
      completionContract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
    }
  | {
      protocol: 'metaclaw:merge-repair:v1';
      publicationId: string;
      conflictChainId: string;
      conflictingPaths: string[];
    }
  /**
   * Kernel-authorized service repair (2026-10-27 realignment §4.3).
   *
   * The Attempt already ended; the required local service did not reach health.
   * This payload is the bounded diagnosis the same Executor category receives so
   * it can repair the service in place. It carries no retry loop: the Kernel owns
   * the repair budget through `repairOrdinal`, and every round is a new
   * authorized Attempt.
   */
  | {
      protocol: 'metawork:service-repair:v1';
      servicePreparation?: {serviceWorktreeId:string;sourceCommit:string;projectPath:string};
      serviceId: string;
      workspaceId: string | null;
      specificationRevision: string;
      /** Zero-based repair round; the Kernel refuses anything but the next one. */
      repairOrdinal: number;
      failure: { kind: 'service'; code: string; summary: string };
      service: {
        command: string;
        args: string[];
        healthUrl: string;
        state: string;
        exitObserved: boolean;
        healthStatus: number | null;
        logTail: string | null;
      };
      knownProgress: string[];
      unknownItems: string[];
    }
  | null;

export interface ControlEventEnvelope {
  schemaVersion: 5;
  configurationRevision: string;
  id: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  sessionId: string;
  /** Immutable semantic owner. Legacy events may omit it during migration. */
  conversationId?: string;
  sourceTurnId?: string;
  workspaceId?: string;
  taskId?: string;
  subtaskId?: string;
  attemptId?: string;
}

export type ControlPlanProposal = PlanningAgentPlan;

export interface RemainingTaskWork {
  sourceTaskId: string;
  sourceVersion: number;
  generationId: string;
  graphRevision: number;
  publicationIds: string[];
  startService: boolean;
}

export type ControlEvent =
  | (ControlEventEnvelope & { type: 'task_remaining_work_retry_requested'; expectedVersion: number })
  | (ControlEventEnvelope & { type: 'managed_service_requested'; operation: LocalServiceOperation; serviceId: string; specification?: LocalServiceSpecification; workspaceId?: string; specificationRevision?: string; turnId?: string })
  | (ControlEventEnvelope & {
      type: 'plan_proposed';
      proposal: ControlPlanProposal;
      requestText: string;
      generationId: string;
      proposalSource: 'initial' | 'replan' | 'conflict_replan';
      targetGraphRevision: number;
      attachmentIds?: string[];
      availabilityExplanation?: string | null;
      /**
       * Server-projected Workspace admission facts (2026-10-25 Planner-owned
       * Workspace mode design §3). The Application Shell canonicalizes the
       * Conversation-bound Workspace; Kernel never reads the filesystem. The
       * facts live on the durable event so an admission replay reaches the same
       * decision without re-asking the Planner.
       */
      workspaceAdmission?: {
        targetWorkspace: WorkspaceAdmissionTargetFact | null;
      };
      /**
       * Bounded, server-produced Span routing observation (ADR-0033
       * amendment). Absent for every revision created before this field
       * existed and whenever the advisor is disabled or fails closed; the
       * Kernel then keeps the deterministic resolver unchanged.
       */
      spanRouting?: SpanRoutingObservation;
    })
  | (ControlEventEnvelope & {
      type: 'dispatch_requested';
      reason: string;
      recovery?: {
        authorizedBinding: AuthorizedExecutorBinding;
        bindingFingerprint: string;
        attemptKind: ControlAttemptKind;
        sourceAttemptId: string | null;
        recoveryMode: ControlRecoveryMode;
        defaultResourceGrant: ResourceClaim[];
        attemptPayload?: ControlAttemptPayload;
      } | null;
    })
  | (ControlEventEnvelope & {
      type: 'task_resume_requested';
      expectedGenerationId?: string;
      expectedGraphRevision?: number;
      blockerCategory: ControlResumeBlockerCategory;
      sourceInputExcerpt: string;
      newlyProvidedResources: string[];
      idempotencyKey: string;
    })
  | (ControlEventEnvelope & {
      type: 'capacity_signal';
      failure?: ControlFailure;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      available: boolean;
      cycleId: string;
      attemptKind: ControlAttemptKind;
      attemptPayload: ControlAttemptPayload;
    })
  | (ControlEventEnvelope & {
      type: 'execution_outcome';
      terminalKind: 'completed' | 'failed';
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      attemptKind: ControlAttemptKind;
      sourceAttemptId: string | null;
      failure: ControlFailure | null;
    })
  | (ControlEventEnvelope & {
      type: 'handoff_contract_failed';
      workUnitId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      contract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
      receiptCount: number;
      responseBytes: number;
    })
  | (ControlEventEnvelope & {
      type: 'execution_result_observed';
      workUnitId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      contract: unknown;
      violations: Array<{ code: string; path: string; message: string }>;
      receiptCount: number;
      responseBytes: number;
      resultId: string | null;
      deliverability: 'deliverable' | 'quarantined';
      certification: 'certified' | 'uncertified';
      safety: 'safe' | 'safety_blocked';
    })
  | (ControlEventEnvelope & {
      type: 'timer_tick';
      wakeKind: 'capacity' | 'retry' | 'availability';
      sourceDecisionId: string;
      scheduledFor: string;
      retry: {
        wakeId: string;
        generationId: string;
        configurationRevision: string;
        authorizedBinding: AuthorizedExecutorBinding;
        bindingFingerprint: string;
        sourceAttemptId: string;
      } | null;
    })
  | (ControlEventEnvelope & {
      type: 'recovery_resolution_requested';
      recoveryItemId: string;
      resolution: 'assume_applied' | 'retry';
    })
  | (ControlEventEnvelope & {
      /**
       * Durable fact that a Task can no longer make progress on its own and no
       * Kernel-authorized driver remains (2026-09-25 review fix). Recovery
       * emits it instead of leaving the Task `running` forever.
       */
      type: 'recovery_required_observed';
      taskId: string;
      recoveryItemId: string;
      reason: string;
    })
  | (ControlEventEnvelope & {
      type: 'permission_requested';
      request: NormalizedCapabilityRequest;
    })
  | (ControlEventEnvelope & {
      type: 'permission_resolution_received';
      actor?: { readonly principalId: string; readonly commandRequestId: string | null };
      requestId: string;
      resolution: 'approve' | 'deny';
      source: 'command' | 'button' | 'planner';
      plannerPlanId: string | null;
    })
  | (ControlEventEnvelope & {
      type: 'partition_conflict_observed';
      claims: ResourceClaim[];
      conflictingLeaseIds: string[];
    })
  | (ControlEventEnvelope & {
      type: 'sandbox_lost';
      containerId: string | null;
      workspaceId: string;
      checkpointId: string | null;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      attemptKind: ControlAttemptKind;
      sourceAttemptId: string | null;
      recoveryMode: ControlRecoveryMode;
    })
  | (ControlEventEnvelope & {
      type: 'merge_conflict_observed';
      publicationId: string;
      conflictChainId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      sourceAttemptId: string;
      repairAttemptsUsed: number;
      conflictReplansUsed: number;
      conflictingPaths: string[];
    })
  | (ControlEventEnvelope & {
      type: 'generation_quiescence_observed';
      requestId: string;
      generationId: string;
      sourceRevision: number;
    });

export interface ControlTaskFact {
  id: string;
  status: ControlTaskStatus;
  conversationId?: string;
  workspaceId?: string;
  /**
   * Workspace execution mode recorded on the Task row. Kernel reads the raw
   * column, so a historical Task may still carry a retired product mode; no
   * admission decision produces one.
   */
  executionMode?: WorkspaceExecutionMode | 'in_place' | 'worktree';
  /** Authorized delivery policy fixed when the Task was admitted. */
  deliveryPolicy?: WorkspaceDeliveryPolicy;
}

export interface ControlSubtaskFact {
  id: string;
  taskId: string;
  status: ControlSubtaskStatus;
  executorBindings: AuthorizedExecutorBinding[];
}

export interface ControlAttemptFact {
  attemptId: string;
  subtaskId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  bindingFingerprint: string;
  attemptKind: ControlAttemptKind;
  sourceAttemptId: string | null;
  terminalKind: 'completed' | 'failed';
  failure: ControlFailure | null;
  completedAt: string;
}

export interface ControlDispatchItemFact {
  attemptId: string;
  subtaskId: string;
  bindingFingerprint: string;
  status: ControlDispatchItemStatus;
  order: number;
}

export interface ControlRetryWakeFact {
  wakeId: string;
  taskId: string;
  subtaskId: string;
  generationId: string;
  sourceDecisionId: string;
  sourceAttemptId: string;
  configurationRevision: string;
  bindingFingerprint: string;
  resumeAt: string;
  status: 'armed' | 'fired' | 'consumed' | 'superseded' | 'recovery_required';
  timerEventId: string | null;
}

export type ControlDependencyReadinessCode =
  | 'ready'
  | 'pending_publication'
  | 'missing_handoff'
  | 'missing_workspace'
  | 'missing_result_object'
  | 'identity_mismatch';

export interface ControlDependencyReadinessFact {
  sourceSubtaskId: string;
  targetSubtaskId: string;
  code: ControlDependencyReadinessCode;
  terminal: boolean;
  detail: string;
}

export interface ControlResumeRecoveryCandidate {
  subtaskId: string;
  sourceAttemptId: string;
  authorizedBinding: AuthorizedExecutorBinding;
  bindingFingerprint: string;
  recoveryMode: Exclude<ControlRecoveryMode, 'fresh'>;
  reason:
    | 'completion_marker_missing'
    | 'completion_no_change_reason_mismatch'
    | 'completion_metadata_invalid'
    | 'execution_interrupted'
    | 'upstream_input_restored';
  attemptKind?: 'continuation' | 'contract_correction';
  attemptPayload?: ControlAttemptPayload;
  correctionFacts?: { receiptCount: number; responseBytes: number };
}

export type ControlSnapshot = { productionAuthorization?: ProductionAuthorizationFact } & (
  | {
      schemaVersion: 5;
      type: 'plan_admission';
      tasks: ControlTaskFact[];
      /** Durable slot state keyed by semantic Conversation owner. */
      activeTaskByConversation?: Record<string, string | null>;
      occupiedConversationIds?: string[];
      queuedTaskCountByConversation?: Record<string, number>;
      activeTaskCount?: number;
      runningTaskId: string | null;
      plannerConfiguration: PlannerConfigurationView;
      kernelConfiguration: ControlConfigurationView;
      executorStatuses: ControlExecutorStatusProjection[];
      v5WorkGraphTaskIds: string[];
      eligibleContextRefKeys: string[];
      pendingAuthorizationRequest: { requestId: string; taskId: string } | null;
    }
  | {
      schemaVersion: 5;
      type: 'dispatch';
      task: ControlTaskFact | null;
      activeTaskByConversation?: Record<string, string | null>;
      runningTaskId: string | null;
      graphState: 'ready' | 'missing' | 'conflict';
      /** Server-projected commercial admission fact; Kernel consumes the fact only. */
      productionAuthorization?: { allowed: boolean; reason?: string };
      subtasks: ControlSubtaskFact[];
      frontier: string[];
      dependencyReadiness?: ControlDependencyReadinessFact[];
      resumeRecoveryCandidates?: ControlResumeRecoveryCandidate[];
      /** Current blockers and rejected replan have been identified from durable facts. */
      upstreamInputResume?: { rejectedReplanRequestId: string | null };
      deliveryRecoveryPublicationIds?: string[];
      pendingRetrySubtaskIds?: string[];
      dispatchItems: ControlDispatchItemFact[];
      maxConcurrentAttempts: number;
      availableSlots: number;
      resourceConflictSubtaskIds: string[];
      capacityProbeBindingFingerprints: Record<string, string[]>;
      /** Durable count of Kernel-authorized service repair rounds per Subtask. */
      serviceRepairAttemptsBySubtask?: Record<string, number>;
      executorStatuses: ControlExecutorStatusProjection[];
      correctionSupportedAgentClasses: string[];
      nativeContinuationAgentClasses: string[];
      attempts: ControlAttemptFact[];
      generationId: string;
      graphRevision: number;
      automaticReplansUsed: number;
      recoverySafety: ControlRecoverySafety;
      automaticRecoveryAllowed: boolean;
      resourceGrantsBySubtask: Record<string, ResourceClaim[]>;
      completionBlockedReasons: string[];
      generationReplanRequest: {
        id: string;
        status: 'pending_quiescence' | 'planning' | 'submitted' | 'failed';
      } | null;
      generationQuiescent: boolean;
    }
  | { schemaVersion: 5; type: 'remaining_work_retry'; task: ControlTaskFact | null;
      remaining: RemainingTaskWork | null; safeToRetry: boolean }
  | {
      schemaVersion: 5;
      type: 'service_control';
      retryOfTaskId?: string | null;
      serviceHandedOver?: boolean;
      task: ControlTaskFact | null;
      published: boolean;
      serviceTaskId: string | null;
      serviceWorkspaceId?: string | null;
      serviceRevision?: string | null;
    }
  | {
      schemaVersion: 5;
      type: 'timer';
      task: ControlTaskFact | null;
      wakeAuthorized: boolean;
      capacityBlockedAt: string | null;
      recheckAfterMs: number;
      capacityBindings: AuthorizedExecutorBinding[];
      nativeContinuationAgentClasses: string[];
      executorStatuses: ControlExecutorStatusProjection[];
      defaultResourceGrant: ResourceClaim[];
      retryWake?: ControlRetryWakeFact | null;
    }
  | {
      schemaVersion: 5;
      type: 'recovery';
      task: ControlTaskFact | null;
      item: {
        id: string;
        kind: 'application' | 'effect';
        status: 'pending' | 'retry_authorized' | 'uncertain' | 'failed';
        retrySafe: boolean;
      } | null;
    }
  | {
      schemaVersion: 5;
      type: 'recovery_required';
      task: ControlTaskFact | null;
      recoveryItemId: string;
      reason: string;
    }
  | {
      schemaVersion: 5;
      type: 'invalid';
      reason: string;
    }
  | {
      schemaVersion: 5;
      type: 'permission';
      request: NormalizedCapabilityRequest | null;
      requestStatus: 'pending' | 'granted' | 'denied' | 'expired' | null;
      rules: PermissionRule[];
      currentGrants: CapabilityGrant[];
      userAuthorizationFingerprints: string[];
      previouslyDeniedFingerprints: string[];
      attemptActive: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
    }
  | {
      schemaVersion: 5;
      type: 'partition';
      conflictConfirmed: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
    }
  | {
      schemaVersion: 5;
      type: 'sandbox_recovery';
      workspaceExists: boolean;
      workspaceId: string | null;
      checkpointId: string | null;
      activeLeaseIds: string[];
      defaultResourceGrant: ResourceClaim[];
    }
);

export type ControlDecisionAction =
  | { type: 'retry_remaining_work'; taskId: string; remaining: RemainingTaskWork }
  | { type: 'reject_request' }
  | { type: 'request_clarification'; question: string }
  | { type: 'no_op' }
  | {
      type: 'authorize_task_plan';
      taskId: string;
      task: ControlPlanProposal['task'];
      workGraph: WorkGraphProposal;
      scheduleState: 'eligible' | 'queued';
      schedulingReason?: 'conversation_slot_occupied' | 'account_task_capacity';
      owner: {
        conversationId: string;
        workspaceId: string | null;
        plannerSessionId: string;
      };
      authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
      generationId: string;
      graphRevision: number;
      proposalSource: 'initial' | 'replan' | 'conflict_replan';
      routing?: Record<string, RoutingResolutionAudit[]>;
      /** Kernel-authorized Workspace execution facts for this Task. */
      workspaceExecution: WorkspaceExecutionDecision;
      /** Current single-Workspace access fact; the legacy decision is retained for event replay. */
      workspaceAdmission?: Extract<WorkspaceAdmission, { kind: 'read' | 'write' }>;
      /** Planner-owned semantics validated with the decision (null for legacy plans). */
      workspaceIntent?: WorkspaceIntent | null;
      /** §5.4 abandon-and-create: the exact old Task to abandon before admission. */
      conflictResolution?: { oldTaskId: string };
    }
  | { type: 'control_managed_service'; taskId: string; serviceId: string; operation: LocalServiceOperation; specification?: LocalServiceSpecification; workspaceId?: string; specificationRevision?: string; turnId?: string }
  | { type: 'authorize_task_control'; task: ControlPlanProposal['task'] }
  | {
      type: 'dispatch_batch';
      taskId: string;
      items: Array<{
        subtaskId: string;
        authorizedBinding: AuthorizedExecutorBinding;
        bindingFingerprint: string;
        attemptId: string;
        attemptKind: ControlAttemptKind;
        sourceAttemptId: string | null;
        recoveryMode: ControlRecoveryMode;
        defaultResourceGrant: ResourceClaim[];
        order: number;
        attemptPayload: ControlAttemptPayload;
      }>;
    }
  | {
      type: 'resume_task';
      taskId: string;
      generationId: string;
      graphRevision: number;
      subtaskIds: string[];
      deliveryPublicationIds?: string[];
      retireReplanRequestId?: string;
      blockerCategory: ControlResumeBlockerCategory;
      recovery?: {
        subtaskId: string;
        sourceAttemptId: string;
        authorizedBinding: AuthorizedExecutorBinding;
        bindingFingerprint: string;
        attemptKind: 'continuation' | 'contract_correction';
        recoveryMode: Exclude<ControlRecoveryMode, 'fresh'>;
        defaultResourceGrant: ResourceClaim[];
        attemptPayload?: ControlAttemptPayload;
      };
    }
  | {
      type: 'probe_capacity';
      taskId: string;
      subtaskId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
    }
  | { type: 'wait_for_capacity'; taskId: string; subtaskId: string }
  | {
      type: 'wait_for_retry';
      taskId: string;
      subtaskId: string;
      resumeAt: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      sourceAttemptId: string;
    }
  | {
      type: 'supersede_retry_wake';
      taskId: string;
      wakeId: string;
    }
  | {
      type: 'recover_retry_wake';
      taskId: string;
      wakeId: string;
      reason: string;
    }
  | { type: 'request_replan'; taskId: string; generationId: string; sourceRevision: number }
  | {
      /**
       * Durable Replan Job authorization (2026-09-25 convergence plan §5). The
       * Runtime only has to make the Job durably schedulable; an account-scoped
       * Planner Worker owns the Planner turn. No foreground Conversation, TUI or
       * Web connection may be required to apply this action.
       */
      type: 'schedule_replan';
      taskId: string;
      generationId: string;
      sourceRevision: number;
      /** Deterministic Job id; doubles as the idempotency key. */
      replanJobId: string;
    }
  | {
      type: 'queue_generation_replan';
      taskId: string;
      generationId: string;
      sourceRevision: number;
      requestId: string;
    }
  | {
      type: 'defer_task_plan_for_availability';
      taskId: string;
      proposalEvent: Extract<ControlEvent, { type: 'plan_proposed' }>;
      authorizedBindingsBySubtask: Record<string, AuthorizedExecutorBinding[]>;
      unavailableAgentClassNames: string[];
      explanation: string;
      workspaceExecution?: WorkspaceExecutionDecision;
      workspaceAdmission?: Extract<WorkspaceAdmission, { kind: 'read' | 'write' }>;
    }
  | {
      type: 'request_merge_replan';
      taskId: string;
      subtaskId: string;
      publicationId: string;
      conflictChainId: string;
    }
  | { type: 'resolve_recovery'; taskId: string; recoveryItemId: string; resolution: 'assume_applied' | 'retry' }
  | {
      type: 'block_work';
      taskId: string;
      subtaskId: string | null;
      preserveSubtaskState?: boolean;
      /**
       * `system` marks a blocker no user input can resolve (a structural defect
       * or an exhausted automatic recovery). It stays `needs_action` — a human
       * must still decide — but it never becomes a "provide input" request.
       */
      blockerKind?: 'user' | 'system';
    }
  /** Safe output exists, but completion evidence is a user decision. */
  | {
      type: 'await_user_decision';
      taskId: string;
      subtaskId: string;
      reason: 'uncertified_result' | 'missing_material' | 'recovery';
    }
  | { type: 'park_for_replan'; taskId: string }
  | { type: 'complete_task'; taskId: string }
  | {
      type: 'record_permission_resolution';
      taskId: string;
      requestId: string;
      resolution: 'approve' | 'deny';
      plannerPlanId: string;
    }
  | {
      type: 'grant_capability';
      requestId: string;
      limits: CapabilityGrant['limits'];
      ruleId: string;
      authorization: { receivedEventId: string; resolution: 'approve'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
    }
  | {
      type: 'deny_capability';
      requestId: string;
      notifyPlanner: false;
      authorization: { receivedEventId: string; resolution: 'deny'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
    }
  | { type: 'escalate_capability'; requestId: string; notifyPlanner: true }
  | { type: 'wait_for_partition'; taskId: string; subtaskId: string; conflictingLeaseIds: string[] }
  | {
      type: 'recover_workspace_attempt';
      taskId: string;
      subtaskId: string;
      workspaceId: string;
      checkpointId: string | null;
      requestId: string | null;
      authorization: { receivedEventId: string; resolution: 'approve'; source: 'command' | 'button' | 'planner'; plannerPlanId: string | null } | null;
      lostAttemptId?: string;
      authorizedBinding?: AuthorizedExecutorBinding;
      bindingFingerprint?: string;
      attemptKind?: ControlAttemptKind;
      sourceAttemptId?: string | null;
      recoveryMode?: ControlRecoveryMode;
      defaultResourceGrant?: ResourceClaim[];
    };

export interface ControlDecision {
  schemaVersion: 5;
  configurationRevision: string;
  id: string;
  eventId: string;
  action: ControlDecisionAction;
  reason: string;
}

/**
 * Applies the production-authorization gate the whole control loop shares.
 *
 * Every policy module — the Task Runtime control loop and the remaining Kernel
 * replay policy — calls it, so one authorization fact cannot be enforced twice
 * or skipped by any owner.
 */
export function guardControlDecision(
  event: ControlEvent,
  snapshot: ControlSnapshot,
  result: ControlDecision,
): ControlDecision {
  if (!allowsControlAction(result.action, snapshot.productionAuthorization)) {
    return decision(event, { type: 'block_work', taskId: event.taskId ?? '', subtaskId: event.subtaskId ?? null, preserveSubtaskState: true },
      snapshot.productionAuthorization?.reason ?? 'official_authorization_required');
  }
  return result;
}

export function decision(event: ControlEvent, action: ControlDecisionAction, reason: string): ControlDecision {
  return {
    schemaVersion: 5,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
    action,
    reason,
  };
}

export function snapshotMatches(event: ControlEvent, snapshot: ControlSnapshot): boolean {
  if (event.type === 'task_remaining_work_retry_requested') return snapshot.type === 'remaining_work_retry';
  if (event.type === 'managed_service_requested') return snapshot.type === 'service_control';
  if (event.type === 'plan_proposed') return snapshot.type === 'plan_admission';
  if (event.type === 'timer_tick') return snapshot.type === 'timer';
  if (event.type === 'task_resume_requested') return snapshot.type === 'dispatch';
  if (event.type === 'recovery_resolution_requested') return snapshot.type === 'recovery';
  if (event.type === 'recovery_required_observed') return snapshot.type === 'recovery_required';
  if (event.type === 'permission_requested' || event.type === 'permission_resolution_received') return snapshot.type === 'permission';
  if (event.type === 'partition_conflict_observed') return snapshot.type === 'partition';
  if (event.type === 'sandbox_lost') return snapshot.type === 'sandbox_recovery';
  return snapshot.type === 'dispatch';
}
