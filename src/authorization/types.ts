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

/** Payment attempt view served by the official service; ISO timestamps are already UTC-normalized. */
export type OfficialPaymentStatus = 'pending' | 'paid' | 'refunded' | 'closed';

export interface OfficialPaymentView {
  readonly hubOrderNo: string;
  readonly attempt: number;
  readonly status: OfficialPaymentStatus;
  readonly amountCents: number;
  readonly qrCodeUrl: string | null;
  readonly expiresAt: string | null;
  readonly paidAt: string | null;
  readonly channelOrderNo: string | null;
}

export interface OfficialOrderView {
  readonly orderId: string;
  readonly plan: 'trial' | 'monthly' | 'annual';
  readonly amountCny: string;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: string;
}

/** 订单列表项：官方 /v1/orders 在 orderView 之上附 payment。 */
export interface OfficialOrderListItem extends OfficialOrderView {
  readonly payment: OfficialPaymentView | null;
}

export interface OfficialOrderPaymentResult {
  readonly order: OfficialOrderView;
  readonly payment: OfficialPaymentView | null;
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
      | 'payment_unavailable'
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
