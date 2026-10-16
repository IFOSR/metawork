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

/** Settlement expiry: same-plan in-period renewal extends from the current expiry; otherwise from payment confirmation. */
export function settlementExpiry({ plan, paidAt, currentEntitlement }) {
  const months = plan === 'annual' ? 12 : 1;
  const now = Date.now();
  const current = currentEntitlement;
  const renewsInPeriod = !!current
    && current.plan === plan
    && (current.status === 'active' || current.status === 'trial')
    && typeof current.expiresAt === 'string'
    && Date.parse(current.expiresAt) > now
    && (!current.effectiveAt || Date.parse(current.effectiveAt) <= now);
  return addCalendarMonths(renewsInPeriod ? current.expiresAt : paidAt, months);
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
