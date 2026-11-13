/**
 * Direct plan admission entry (ADR-0055 §6, D2-3b-2c).
 *
 * Producers evaluate the single admission policy themselves and hand the result
 * to `PlanAdmissionApplier`. Keeping the snapshot projection here means no
 * producer has to know the Kernel snapshot shape once that type is deleted.
 */
import type { ControlSnapshot } from '../control/control-contracts.js';
import {
  authorizePlanAdmission,
  type PlanAdmissionRequest,
  type PlanAdmissionResult,
  type PlanAdmissionSnapshot,
} from './plan-admission-policy.js';

export function planAdmissionSnapshotFromControl(
  snapshot: Extract<ControlSnapshot, { type: 'plan_admission' }>,
): PlanAdmissionSnapshot {
  const { schemaVersion: _schemaVersion, type: _type, kernelConfiguration, ...rest } = snapshot;
  return { ...rest, configuration: kernelConfiguration };
}

export function evaluatePlanAdmission(
  request: PlanAdmissionRequest,
  snapshot: PlanAdmissionSnapshot,
): PlanAdmissionResult {
  return authorizePlanAdmission(request, snapshot);
}
