import { createHmac } from 'node:crypto';

/** Plans that can be bought repeatedly; the trial is a one-off activation per account. */
export const PAID_PLANS = ['monthly', 'annual'];

/** UTC calendar periods, clamped to the last day of the target month. */
export function addCalendarMonths(value, months) {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

/** Integer-cent <-> decimal-string money conversions; amounts never touch floating point. */
export function yuanToCents(value) {
  const match = /^(\d+)\.(\d{2})$/u.exec(String(value));
  if (!match) throw new Error(`invalid yuan amount ${value}`);
  return Number(match[1]) * 100 + Number(match[2]);
}
export function centsToYuan(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cent amount ${cents}`);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Settlement expiry: only the same paid plan stacks onto the current expiry; anything else starts at payment confirmation. */
export function settlementExpiry({ plan, paidAt, currentEntitlement }) {
  const months = plan === 'annual' ? 12 : 1;
  const now = Date.now();
  const current = currentEntitlement;
  // 同一种订阅才能叠加：当前权益仍是同一个付费套餐且未到期时，本次续费从到期日顺延。
  // 跨套餐（月↔年）与试用转付费都按购买时间重新计算，不叠加上一个套餐的剩余时长。
  const stacksOnPeriod = !!current
    && current.plan === plan
    && PAID_PLANS.includes(plan)
    && current.status === 'active'
    && typeof current.expiresAt === 'string'
    && Date.parse(current.expiresAt) > now
    && (!current.effectiveAt || Date.parse(current.effectiveAt) <= now);
  return addCalendarMonths(stacksOnPeriod ? current.expiresAt : paidAt, months);
}

/** Refund rollback target: re-grant the revision that preceded the refunded license; without one the account returns to revoked. */
export function refundRestoreRevision(licenseHistory, refundedLicenseId) {
  const index = licenseHistory.findIndex(row => row.id === refundedLicenseId);
  if (index === -1) return null;
  const previous = licenseHistory[index - 1];
  if (previous) return { plan: previous.plan, status: previous.status, expiresAt: previous.expires_at };
  return { plan: licenseHistory[index].plan, status: 'revoked', expiresAt: null };
}

/** Parse an OPC Hub "YYYY-MM-DD HH:MM:SS" timestamp (Asia/Shanghai) into UTC ISO; null when malformed. */
export function parseHubDatetime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(+year, +month - 1, +day, +hour - 8, +minute, +second)).toISOString();
}
