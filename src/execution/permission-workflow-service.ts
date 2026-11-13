import { randomUUID } from 'node:crypto';
import type { AttemptExecutionBackend } from './attempt-execution-backend.js';
import type { CapabilityResourceResolverPort } from './capability-resource-resolver.js';
import {
  capabilityRequestFingerprint,
  type CapabilityRequestInput,
  type CapabilityUseInput,
  type CapabilityUseResult,
  type NormalizedCapabilityRequest,
  type PermissionRequestRecord,
  type PermissionRepositoryPort,
  type PermissionResolutionRecord,
  type PermissionRule,
} from '../resource/index.js';
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import {
  type PermissionResolutionEvent,
} from '../control/control-workflow.js';
import { defaultGrantLimits, evaluateCapabilityRequest } from '../resource/permission-policy.js';
import type { ManagerPermissionJudge } from '../resource/manager-permission-judge.js';
export type { ManagerPermissionJudge } from '../resource/manager-permission-judge.js';

export interface PermissionAttemptContext {
  sessionId: string;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  agentClassName: string;
  configurationRevision: string;
  /** Existing durable dispatch authorization used as the FK anchor for facts. */
  authorizedDecisionId?: string;
  permissionProfileId: NormalizedCapabilityRequest['permissionProfileId'];
  containerId: string;
  workspaceId: string;
  checkpointId: string | null;
}

export interface PermissionWorkflowHooks {
  checkpoint(reason: 'permission_suspended'): Promise<string | null>;
  onEscalation(request: NormalizedCapabilityRequest, reason: string): Promise<void>;
  onRecoveryAuthorized(input: { request: NormalizedCapabilityRequest | null; workspaceId: string; checkpointId: string | null; decision?: ControlDecision }): Promise<ControlEvent | void>;
}

/**
 * Optional Manager decision seam. The Host policy still owns hard-deny and
 * explicit profile rules; only an otherwise undecidable request reaches this
 * callback. Invalid, timed-out, or scope-expanding answers are treated as an
 * escalation so the user remains the final decision maker.
 */
export const PERMISSION_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function capabilityDecisionId(requestId: string, outcome: 'grant' | 'deny' | 'escalate'): string {
  return `executor_capability_${outcome}_${requestId}`;
}

const MANAGER_PERMISSION_TIMEOUT_MS = 10_000;

async function withManagerTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('manager_permission_timeout'));
        }, MANAGER_PERMISSION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export function permissionRequestExpiresAt(createdAt: string): string | null {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return new Date(createdAtMs + PERMISSION_REQUEST_MAX_AGE_MS).toISOString();
}

export function isPermissionRequestActive(createdAt: string, now: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - createdAtMs;
  return ageMs >= 0 && ageMs <= PERMISSION_REQUEST_MAX_AGE_MS;
}

export class PermissionWorkflowService {
  constructor(private readonly deps: {
    context: PermissionAttemptContext;
    repository: PermissionRepositoryPort;
    resolver: CapabilityResourceResolverPort;
    executionBackend: AttemptExecutionBackend;
    /**
     * Applies the post-grant continuation (`task_resume_requested`) on the Task's
     * own control loop. Every path that can authorize a recovery attempt wires it.
     */
    deliverContinuation?: (event: ControlEvent) => Promise<void>;
    rules: PermissionRule[];
    hooks: PermissionWorkflowHooks;
    manager?: ManagerPermissionJudge;
    /** Runtime cancellation/claim fence, checked again after model IO. */
    isAttemptCurrent?: () => boolean;
    clock?: { now(): string };
  }) {}

  private decisionId(outcome: 'grant' | 'deny' | 'escalate', requestId: string): string {
    return this.deps.context.authorizedDecisionId ?? capabilityDecisionId(requestId, outcome);
  }

  async request(input: CapabilityRequestInput): Promise<{
    requestId: string;
    grantId: string | null;
    status: string;
    reason: string | null;
  }> {
    if (this.deps.isAttemptCurrent?.() === false) throw new Error('permission_attempt_stale');
    const now = this.now();
    const ordinal = this.deps.repository.countDistinctForAttempt(this.deps.context.attemptId) + 1;
    const request: NormalizedCapabilityRequest = {
      ...input,
      id: `permission_request_${randomUUID()}`,
      fingerprint: '',
      taskId: this.deps.context.taskId,
      generationId: this.deps.context.generationId,
      subtaskId: this.deps.context.subtaskId,
      attemptId: this.deps.context.attemptId,
      agentClassName: this.deps.context.agentClassName,
      permissionProfileId: this.deps.context.permissionProfileId,
      partition: this.deps.resolver.resolve(input),
      distinctRequestOrdinal: ordinal,
    };
    request.fingerprint = capabilityRequestFingerprint(request);
    const record = this.deps.repository.createRequest(request, now);
    if (record.status !== 'pending') return this.requestResult(record);
    const event: Extract<ControlEvent, { type: 'permission_requested' }> = {
      schemaVersion: 5,
      configurationRevision: this.deps.context.configurationRevision,
      type: 'permission_requested',
      id: `permission_event_${record.request.id}`,
      correlationId: record.request.id,
      causationId: null,
      occurredAt: now,
      sessionId: this.deps.context.sessionId,
      taskId: record.request.taskId,
      subtaskId: record.request.subtaskId,
      attemptId: record.request.attemptId,
      request: record.request,
    };
    // Persist before pause/checkpoint/model IO. Startup may recover a claimed
    // work item, but a periodic worker must not race a live Manager judgment.
    this.enqueuePermissionWork(event);
    if (!this.claimPermissionWork(event.id, now)) {
      return this.requestResult(this.deps.repository.findRequest(record.request.id) ?? record);
    }
    try {
      await this.deps.executionBackend.pause(this.deps.context.containerId);
      const checkpointId = await this.deps.hooks.checkpoint('permission_suspended');
      this.deps.context.checkpointId = checkpointId;
    } catch (error) {
      this.releasePermissionWork(event.id, this.now());
      await this.resumeIfPresent().catch(() => undefined);
      throw error;
    }
    try {
      await this.applyCapabilityPolicy(record.request, null);
      this.markPermissionWorkApplied(event.id, this.now());
    } catch (error) {
      this.releasePermissionWork(event.id, this.now());
      throw error;
    }
    const latest = this.deps.repository.findRequest(record.request.id);
    if (latest) return this.requestResult(latest);
    return this.requestResult(record);
  }

  use(input: CapabilityUseInput): CapabilityUseResult {
    if (this.deps.isAttemptCurrent?.() === false) {
      return { status: 'denied', grantId: input.grantId, reason: 'permission attempt is no longer current' };
    }
    const bytes = Buffer.byteLength(input.payload, 'utf8');
    const grant = this.deps.repository.consumeGrant(
      input.grantId,
      this.deps.context.attemptId,
      bytes,
      this.now(),
    );
    if (!grant) {
      return {
        status: 'denied',
        grantId: input.grantId,
        reason: 'grant is expired, exhausted, revoked, or belongs to another attempt',
      };
    }
    return {
      status: 'consumed',
      grantId: grant.id,
      callsUsed: grant.callsUsed,
      bytesUsed: grant.bytesUsed,
      remainingCalls: grant.limits.maxCalls - grant.callsUsed,
      remainingBytes: grant.limits.maxBytes - grant.bytesUsed,
      expiresAt: grant.limits.expiresAt,
    };
  }

  async resolve(input: {
    requestId: string;
    resolution: 'approve' | 'deny';
    source: 'command' | 'button' | 'planner';
    plannerPlanId?: string | null;
    actor?: { readonly principalId: string; readonly commandRequestId: string | null };
  }): Promise<{ status: 'accepted' | 'replayed' | 'conflict'; resolution: 'approve' | 'deny' }> {
    const previous = this.deps.repository.findResolution?.(input.requestId) ?? null;
    if (previous) {
      if (previous.sessionId !== this.deps.context.sessionId || previous.taskId !== this.deps.context.taskId) {
        throw new Error('permission decision belongs to another Conversation or Task');
      }
      return { status: previous.resolution === input.resolution ? 'replayed' : 'conflict', resolution: previous.resolution };
    }
    const record = this.deps.repository.findRequest(input.requestId);
    if (!record || record.request.taskId !== this.deps.context.taskId
      || record.request.generationId !== this.deps.context.generationId
      || record.request.attemptId !== this.deps.context.attemptId
      || !['pending', 'escalated'].includes(record.status)) {
      throw new Error('permission request is missing, stale, or belongs to another Task');
    }
    if (!isPermissionRequestActive(record.createdAt, this.now())) {
      throw new Error('permission request has expired and must be reissued precisely');
    }
    const event: PermissionResolutionEvent = {
      schemaVersion: 5,
      configurationRevision: this.deps.context.configurationRevision,
      type: 'permission_resolution_received',
      id: `permission_resolution_${input.requestId}`,
      correlationId: input.requestId,
      causationId: null,
      occurredAt: this.now(),
      sessionId: this.deps.context.sessionId,
      taskId: record.request.taskId,
      subtaskId: record.request.subtaskId,
      attemptId: record.request.attemptId,
      requestId: input.requestId,
      resolution: input.resolution,
      source: input.source,
      plannerPlanId: input.plannerPlanId ?? null,
      ...(input.actor ? { actor: input.actor } : {}),
    };
    const recorded = this.deps.repository.recordResolution?.(permissionResolutionRecord(event));
    if (recorded === 'replayed' || recorded === 'conflict') {
      return { status: recorded === 'replayed' ? 'replayed' : 'conflict', resolution: event.resolution };
    }
    this.enqueuePermissionWork(event);
    if (!this.claimPermissionWork(event.id, this.now())) {
      return { status: 'accepted', resolution: event.resolution };
    }
    {
      const recordAfterAdmission = this.deps.repository.findRequest(input.requestId);
      if (!recordAfterAdmission) throw new Error('permission request disappeared during resolution');
      this.deps.repository.recordAuthorization(recordAfterAdmission.request, {
        receivedEventId: event.id,
        resolution: event.resolution,
        source: event.source,
        plannerPlanId: event.plannerPlanId,
      }, this.now());
      try {
        const continuation = await this.applyCapabilityPolicy(recordAfterAdmission.request, event);
        if (continuation) await this.deliverContinuation(continuation);
        this.markPermissionWorkApplied(event.id, this.now());
      } catch (error) {
        this.releasePermissionWork(event.id, this.now());
        throw error;
      }
    }
    return { status: 'accepted', resolution: input.resolution };
  }

  async recover(event: ControlEvent): Promise<void> {
    if ((event.type !== 'permission_requested' && event.type !== 'permission_resolution_received')
      || event.sessionId !== this.deps.context.sessionId || event.taskId !== this.deps.context.taskId
      || event.attemptId !== this.deps.context.attemptId) throw new Error('permission_recovery_scope_mismatch');
    const record = this.deps.repository.findRequest(event.correlationId);
    if (!record) throw new Error('permission request disappeared during recovery');
    this.enqueuePermissionWork(event);
    if (event.type === 'permission_requested') {
      // A restarted process cannot establish whether an interrupted model
      // approved the request. Keep its grant closed and expose one precise
      // user decision. Already durable outcomes never re-run the model.
      if (record.status === 'pending') {
        const reason = 'Manager permission judgment was interrupted; user decision required';
        this.deps.repository.escalate(record.request.id, this.decisionId('escalate', record.request.id), reason, this.now());
        await this.deps.hooks.onEscalation(record.request, reason);
      } else if (record.status === 'escalated') {
        await this.deps.hooks.onEscalation(record.request, record.decisionReason ?? 'user decision required');
      } else {
        await this.resumeIfPresent();
      }
      this.markPermissionWorkApplied(event.id, this.now());
      return;
    }
    if (event.type === 'permission_resolution_received') {
      this.deps.repository.recordResolution?.(permissionResolutionRecord(event));
      this.deps.repository.recordAuthorization(record.request, {
        receivedEventId: event.id,
        resolution: event.resolution,
        source: event.source,
        plannerPlanId: event.plannerPlanId,
      }, this.now());
    }
    const continuation = await this.applyCapabilityPolicy(record.request,
      event.type === 'permission_resolution_received' ? event : null);
    if (continuation) await this.deliverContinuation(continuation);
    if (event.type === 'permission_resolution_received') {
      this.markPermissionWorkApplied(event.id, this.now());
    }
  }

  private async applyCapabilityPolicy(
    request: NormalizedCapabilityRequest,
    resolution: PermissionResolutionEvent | null,
  ): Promise<ControlEvent | void> {
    const authorization = resolution ? {
      receivedEventId: resolution.id,
      resolution: resolution.resolution,
      source: resolution.source,
      plannerPlanId: resolution.plannerPlanId,
    } : undefined;
    let grantedScope = request.suggestedScope;
    let result = evaluateCapabilityRequest({
      request,
      rules: this.deps.rules,
      now: this.now(),
      previouslyDeniedFingerprints: this.deps.repository.listDeniedFingerprints(request.attemptId),
      userAuthorizationFingerprints: this.deps.repository.listApprovedFingerprints(request.taskId),
    });
    if (result.type === 'deny_capability'
      && result.reason === 'no explicit permission rule covers this request') {
      if (!this.deps.manager) {
        // An unclassified capability is precisely the case where the Manager
        // cannot establish intent. Escalate it for an explicit user decision;
        // never silently deny a legitimate request or silently grant it.
        result = {
          type: 'escalate_capability',
          ruleId: null,
          reason: 'Manager decision is unavailable for this capability; user decision required',
        };
      } else {
        try {
          const judged = await withManagerTimeout(signal => this.deps.manager!.judge(structuredClone(request), { signal }));
          const scopeValid = judged.grantedScope === undefined
            || judged.grantedScope === request.suggestedScope
            || (request.suggestedScope === 'attempt' && judged.grantedScope === 'once');
          if (judged.verdict === 'grant' && scopeValid && judged.reason.trim().length > 0) {
            const limits = defaultGrantLimits(request, this.now());
            // A Manager may narrow the requested scope, never widen it. The
            // grant record must carry the narrowed limits as well; otherwise a
            // one-shot Manager answer accidentally receives the default
            // attempt-wide allowance.
            if (judged.grantedScope === 'once') {
              limits.maxCalls = 1;
              grantedScope = 'once';
            }
            result = {
              type: 'grant_capability',
              ruleId: 'manager',
              reason: judged.reason,
              limits,
            };
          } else if (judged.verdict === 'deny' && judged.reason.trim().length > 0) {
            result = { type: 'deny_capability', ruleId: 'manager', reason: judged.reason.trim() };
          } else {
            result = {
              type: 'escalate_capability',
              ruleId: 'manager',
              reason: judged.reason || 'Manager could not determine whether the capability is safe',
            };
          }
        } catch {
          result = {
            type: 'escalate_capability',
            ruleId: 'manager',
            reason: 'Manager decision failed or timed out; user decision required',
          };
        }
      }
    }
    if (this.deps.isAttemptCurrent?.() === false) {
      const current = this.deps.repository.findRequest(request.id);
      if (current && ['pending', 'escalated'].includes(current.status)) {
        this.deps.repository.deny({ decisionId: this.decisionId('deny', request.id), request,
          reason: 'permission attempt is no longer current', deniedAt: this.now() });
      }
      return;
    }
    if (resolution?.resolution === 'deny') {
      this.deps.repository.deny({
        decisionId: this.decisionId('deny', request.id),
        request,
        reason: 'user denied the exact capability request',
        deniedAt: this.now(),
        authorization,
      });
      await this.resumeIfPresent();
      return;
    }
    if (resolution?.resolution === 'approve') {
      if (result.type !== 'grant_capability') {
        // A user approval can satisfy an escalation, but it can never
        // override a platform hard deny or an invalid request.
        this.deps.repository.deny({
          decisionId: this.decisionId('deny', request.id),
          request,
          reason: result.reason,
          deniedAt: this.now(),
          authorization,
        });
        await this.resumeIfPresent();
        return;
      }
      if (!this.deps.context.workspaceId) {
        this.deps.repository.deny({
          decisionId: this.decisionId('deny', request.id),
          request,
          reason: 'approved request has no recoverable workspace',
          deniedAt: this.now(),
          authorization,
        });
        await this.resumeIfPresent();
        return;
      }
      // A new attempt re-evaluates this exact fingerprint with the persisted
      // authorization. The paused process never receives a grant directly.
      return this.deps.hooks.onRecoveryAuthorized({
        request,
        workspaceId: this.deps.context.workspaceId,
        checkpointId: this.deps.context.checkpointId,
      });
    }
    if (result.type === 'grant_capability') {
      // The grant is owner-owned: no ledger anchor row is created (ADR-0055 D6).
      const decisionId = this.decisionId('grant', request.id);
      this.deps.repository.grant({
        decisionId,
        request,
        limits: result.limits,
        scope: grantedScope,
        reason: result.reason,
        grantedAt: this.now(),
        authorization,
      });
      await this.resumeIfPresent();
      return;
    }
    if (result.type === 'escalate_capability') {
      this.deps.repository.escalate(request.id, this.decisionId('escalate', request.id), result.reason, this.now());
      await this.deps.hooks.onEscalation(request, result.reason);
      return;
    }
    this.deps.repository.deny({
      decisionId: this.decisionId('deny', request.id),
      request,
      reason: result.reason,
      deniedAt: this.now(),
    });
    await this.resumeIfPresent();
  }

  private buildSnapshot(event: ControlEvent): ControlSnapshot {
    const requestId = event.type === 'permission_requested'
      ? event.request.id
      : event.type === 'permission_resolution_received' ? event.requestId : '';
    const record = this.deps.repository.findRequest(requestId);
    return {
      schemaVersion: 5,
      type: 'permission',
      request: record?.request ?? null,
      requestStatus: record?.status === 'escalated' ? 'pending' : record?.status ?? null,
      rules: this.deps.rules,
      currentGrants: record ? this.deps.repository.listGrants(record.request.attemptId) : [],
      userAuthorizationFingerprints: record ? this.deps.repository.listApprovedFingerprints(record.request.taskId) : [],
      previouslyDeniedFingerprints: record ? this.deps.repository.listDeniedFingerprints(record.request.attemptId) : [],
      attemptActive: false,
      workspaceId: this.deps.context.workspaceId,
      checkpointId: this.deps.context.checkpointId,
    };
  }

  private async apply(decision: ControlDecision): Promise<ControlEvent | null> {
    const action = decision.action;
    if (
      action.type !== 'grant_capability'
      && action.type !== 'deny_capability'
      && action.type !== 'escalate_capability'
      && action.type !== 'recover_workspace_attempt'
    ) {
      throw new Error(`permission workflow cannot apply ${action.type}`);
    }
    if (action.type === 'recover_workspace_attempt') {
      const record = action.requestId ? this.deps.repository.findRequest(action.requestId) : null;
      if (record && action.authorization) {
        this.deps.repository.recordAuthorization(record.request, action.authorization, this.now());
      }
      const continuation = await this.deps.hooks.onRecoveryAuthorized({
        request: record?.request ?? null,
        workspaceId: action.workspaceId,
        checkpointId: action.checkpointId,
        decision,
      });
      return continuation ?? null;
    }
    const record = this.deps.repository.findRequest(action.requestId);
    if (!record) throw new Error(`permission request not found: ${action.requestId}`);
    if (action.type === 'grant_capability') {
      this.deps.repository.grant({
        decisionId: decision.id,
        request: record.request,
        limits: action.limits,
        grantedAt: this.now(),
        authorization: action.authorization ?? undefined,
      });
      await this.resumeIfPresent();
      return null;
    }
    if (action.type === 'deny_capability') {
      this.deps.repository.deny({
        decisionId: decision.id,
        request: record.request,
        reason: decision.reason,
        deniedAt: this.now(),
        authorization: action.authorization ?? undefined,
      });
      await this.resumeIfPresent();
      return null;
    }
    this.deps.repository.escalate(record.request.id, decision.id, decision.reason, this.now());
    await this.deps.hooks.onEscalation(record.request, decision.reason);
    return null;
  }

  private async resumeIfPresent(): Promise<void> {
    if (this.deps.isAttemptCurrent?.() === false) return;
    const execution = await this.deps.executionBackend.inspect(this.deps.context.containerId);
    if (execution?.status === 'paused' && this.deps.isAttemptCurrent?.() !== false) {
      await this.deps.executionBackend.resume(this.deps.context.containerId);
    }
  }

  private requestResult(record: PermissionRequestRecord): {
    requestId: string;
    grantId: string | null;
    status: string;
    reason: string | null;
  } {
    const grant = record.status === 'granted'
      ? this.deps.repository.listGrants(record.request.attemptId)
        .find(item => item.requestId === record.request.id) ?? null
      : null;
    return {
      requestId: record.request.id,
      grantId: grant?.id ?? null,
      status: record.status,
      reason: record.decisionReason,
    };
  }

  private now(): string {
    return this.deps.clock?.now() ?? new Date().toISOString();
  }

  private async deliverContinuation(event: ControlEvent): Promise<void> {
    if (!this.deps.deliverContinuation) {
      throw new Error('permission continuation requires an owner delivery port');
    }
    await this.deps.deliverContinuation(event);
  }

  private enqueuePermissionWork(event: ControlEvent): void {
    if (event.type !== 'permission_requested' && event.type !== 'permission_resolution_received') return;
    this.deps.repository.enqueuePermissionWork?.({
      eventId: event.id,
      requestId: event.type === 'permission_requested' ? event.request.id : event.requestId,
      eventType: event.type,
      createdAt: event.occurredAt,
    });
  }

  private claimPermissionWork(eventId: string, now: string): boolean {
    if (this.deps.repository.claimPermissionWork) {
      if (!this.deps.repository.claimPermissionWork(eventId, now)) return false;
      return true;
    }
    return true;
  }

  private releasePermissionWork(eventId: string, now: string): void {
    if (this.deps.repository.releasePermissionWork) {
      this.deps.repository.releasePermissionWork(eventId, now);
    }
  }

  private markPermissionWorkApplied(eventId: string, now: string): void {
    if (this.deps.repository.markPermissionWorkApplied) {
      this.deps.repository.markPermissionWorkApplied(eventId, now);
    }
    // DEBUG
    // console.error('marked permission work', eventId);
    // console.debug('permission applied', eventId);
  }
}

function permissionResolutionRecord(event: PermissionResolutionEvent): PermissionResolutionRecord {
  return {
    requestId: event.requestId,
    eventId: event.id,
    sessionId: event.sessionId,
    taskId: event.taskId ?? '',
    subtaskId: event.subtaskId ?? '',
    attemptId: event.attemptId ?? '',
    resolution: event.resolution,
    source: event.source,
    plannerPlanId: event.plannerPlanId,
    createdAt: event.occurredAt,
  };
}
