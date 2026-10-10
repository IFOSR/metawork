/** Public commercial authorization facts shared by Server, Gateway and Kernel. */
export type OfficialEntitlementStatus =
  | 'active'
  | 'trial'
  | 'pending_payment'
  | 'expired'
  | 'revoked'
  | 'unknown';

export type OfficialAuthorizationState =
  | 'logged_out'
  | 'active'
  | 'pending_payment'
  | 'expired'
  | 'revoked'
  | 'unavailable';

export interface OfficialAccount {
  readonly accountId: string;
  readonly email: string;
  readonly displayName?: string;
}

export interface OfficialEntitlement {
  readonly status: OfficialEntitlementStatus;
  readonly plan: 'trial' | 'monthly' | 'annual' | 'internal_perpetual' | null;
  readonly effectiveAt: string | null;
  readonly expiresAt: string | null;
  readonly revision: number;
  readonly serverTime: string;
}

export interface OfficialAuthorizationProjection {
  readonly state: OfficialAuthorizationState;
  readonly account: OfficialAccount | null;
  readonly entitlement: OfficialEntitlement | null;
  readonly verifiedAt: string | null;
  readonly nextDailyCheckAt: string | null;
  readonly reason?: string;
}

export interface OfficialLoginResult {
  readonly account: OfficialAccount;
  readonly entitlement: OfficialEntitlement;
}

export interface OfficialAiRequest {
  readonly operation: 'responsibility_rewrite' | 'model_summary' | 'capability_explanation';
  readonly requestId: string;
  readonly input: unknown;
}

export interface OfficialAiResult {
  readonly operation: OfficialAiRequest['operation'];
  readonly result: unknown;
  readonly entitlement: OfficialEntitlement;
}

export class OfficialAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'request_rejected'
      | 'already_logged_in'
      | 'invalid_credentials'
      | 'session_invalid'
      | 'entitlement_inactive'
      | 'verification_unavailable'
      | 'official_ai_unavailable'
      | 'official_protocol_error',
  ) {
    super(message);
    this.name = 'OfficialAuthorizationError';
  }
}

export function isEntitlementUsable(entitlement: OfficialEntitlement | null, now = Date.now()): boolean {
  if (!entitlement || !['active', 'trial'].includes(entitlement.status)) return false;
  if (!entitlement.effectiveAt || Date.parse(entitlement.effectiveAt) > now) return false;
  if (!entitlement.expiresAt) return entitlement.plan === 'internal_perpetual';
  return Date.parse(entitlement.expiresAt) > now;
}
