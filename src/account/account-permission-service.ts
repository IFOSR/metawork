import type { PlannerTuiPermissionRequest } from '../session/session-types.js';

export interface AccountPermissionResolutionInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly resolution: 'approve' | 'deny';
  readonly source: 'button' | 'planner';
  readonly plannerPlanId: string | null;
  readonly expectedRevision?: string;
  readonly expectedGenerationId?: string;
  /** Authenticated Gateway attribution; never inferred from the notification destination. */
  readonly actor?: { readonly principalId: string; readonly commandRequestId: string | null };
}

export interface AccountPermissionResolutionResult {
  readonly status: 'resolved' | 'replayed' | 'conflict';
  readonly resolution: 'approve' | 'deny' | null;
  readonly message: string;
  readonly recoveryTaskId: string | null;
}

export interface AccountPermissionService {
  listForSession(sessionId: string, afterId?: string, limit?: number): Array<PlannerTuiPermissionRequest & { readonly requestRevision: string }>;
  resolve(input: AccountPermissionResolutionInput): Promise<AccountPermissionResolutionResult>;
}
