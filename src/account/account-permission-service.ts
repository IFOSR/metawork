import type { PlannerTuiPermissionRequest } from '../session/session-types.js';

export interface AccountPermissionResolutionInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly resolution: 'approve' | 'deny';
  readonly source: 'button' | 'planner';
  readonly plannerPlanId: string | null;
}

export interface AccountPermissionResolutionResult {
  readonly status: 'resolved' | 'replayed' | 'conflict';
  readonly resolution: 'approve' | 'deny' | null;
  readonly message: string;
  readonly recoveryTaskId: string | null;
}

export interface AccountPermissionService {
  listForSession(sessionId: string): PlannerTuiPermissionRequest[];
  resolve(input: AccountPermissionResolutionInput): Promise<AccountPermissionResolutionResult>;
}
