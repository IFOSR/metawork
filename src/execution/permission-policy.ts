/**
 * Task Runtime permission policy (ADR-0055 D4/D6).
 *
 * Formerly the Kernel permission decider. The Runtime owns the capability
 * request/decision round: it evaluates the exact request against the authorized
 * rules and the user authorization facts and returns one owner operation
 * (grant / escalate / deny / bounded workspace recovery attempt). Executor/Host
 * still owns tool execution; this module only authorizes the bounded grant.
 */
import type { ControlDecision, ControlEvent, ControlSnapshot } from '../control/control-contracts.js';
import { decision } from '../control/control-contracts.js';
import { evaluateCapabilityRequest } from '../resource/index.js';

export function decidePermission(
  event: Extract<ControlEvent, { type: 'permission_requested' | 'permission_resolution_received' }>,
  snapshot: Extract<ControlSnapshot, { type: 'permission' }>,
): ControlDecision {
  const request = snapshot.request;
  if (!request || request.taskId !== event.taskId || request.subtaskId !== event.subtaskId) {
    return decision(event, { type: 'deny_capability', requestId: request?.id ?? '', notifyPlanner: false, authorization: null }, 'permission request identity mismatch');
  }
  if (event.type === 'permission_resolution_received' && event.requestId !== request.id) {
    return decision(event, { type: 'deny_capability', requestId: event.requestId, notifyPlanner: false, authorization: null }, 'permission resolution request ID mismatch');
  }
  if (snapshot.requestStatus !== 'pending') {
    const existing = snapshot.currentGrants.find(grant => grant.requestId === request.id);
    if (existing && snapshot.requestStatus === 'granted') {
      return decision(event, {
        type: 'grant_capability',
        requestId: request.id,
        limits: existing.limits,
        ruleId: 'existing_grant',
        authorization: null,
      }, 'duplicate request returns the existing grant');
    }
    return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, `permission request is ${snapshot.requestStatus ?? 'missing'}`);
  }
  if (event.type === 'permission_resolution_received' && event.resolution === 'deny') {
    return decision(event, {
      type: 'deny_capability',
      requestId: request.id,
      notifyPlanner: false,
      authorization: {
        receivedEventId: event.id,
        resolution: 'deny',
        source: event.source,
        plannerPlanId: event.plannerPlanId,
      },
    }, 'user denied the exact capability request');
  }
  if (event.type === 'permission_resolution_received' && !snapshot.attemptActive) {
    if (!snapshot.workspaceId) {
      return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, 'approved request has no recoverable workspace');
    }
    return decision(event, {
      type: 'recover_workspace_attempt',
      taskId: request.taskId,
      subtaskId: request.subtaskId,
      workspaceId: snapshot.workspaceId,
      checkpointId: snapshot.checkpointId,
      requestId: request.id,
      authorization: {
        receivedEventId: event.id,
        resolution: 'approve',
        source: event.source,
        plannerPlanId: event.plannerPlanId,
      },
    }, 'user authorization recorded; a fresh recovery attempt must receive a new bounded grant');
  }
  const authorizationFingerprints = event.type === 'permission_resolution_received'
    ? [...new Set([...snapshot.userAuthorizationFingerprints, request.fingerprint])]
    : snapshot.userAuthorizationFingerprints;
  const result = evaluateCapabilityRequest({
    request,
    rules: snapshot.rules,
    now: event.occurredAt,
    previouslyDeniedFingerprints: snapshot.previouslyDeniedFingerprints,
    userAuthorizationFingerprints: authorizationFingerprints,
  });
  if (result.type === 'grant_capability') {
    return decision(event, {
      type: 'grant_capability',
      requestId: request.id,
      limits: result.limits,
      ruleId: result.ruleId,
      authorization: event.type === 'permission_resolution_received' ? {
        receivedEventId: event.id,
        resolution: 'approve',
        source: event.source,
        plannerPlanId: event.plannerPlanId,
      } : null,
    }, result.reason);
  }
  if (result.type === 'escalate_capability') {
    return decision(event, { type: 'escalate_capability', requestId: request.id, notifyPlanner: true }, result.reason);
  }
  return decision(event, { type: 'deny_capability', requestId: request.id, notifyPlanner: false, authorization: null }, result.reason);
}
