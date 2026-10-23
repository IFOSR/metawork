/**
 * Durable settlement of an authorized Kernel Decision whose Runtime apply
 * produced no observation.
 *
 * The 2026-10-22 review found the blocking failure mode: a deterministic
 * refusal (unpublished code, service ownership mismatch, Kernel
 * `reject_request`) was thrown out of the Runtime, the parent
 * `authorize_task_control` application was persisted as `uncertain`, generic
 * recovery could not prove a postcondition, and the Conversation slot stayed
 * occupied forever.
 *
 * The 2026-10-23 diagnostic review required a structured result instead of a
 * free-text error: only a provable outcome may settle the parent application,
 * and anything genuinely unknown must stay `uncertain` so it reaches the user
 * (ADR-0022/0023). A settlement is therefore written as a tagged summary that
 * recovery can read back without guessing from prose:
 *
 *     kernel_settlement/rejected_without_effect:service_not_published ...
 *     kernel_settlement/operation_settled:service_operation_failed ...
 */
export type KernelApplicationSettlementKind =
  | 'rejected_without_effect'
  | 'operation_settled';

export interface KernelApplicationSettlement {
  readonly kind: KernelApplicationSettlementKind;
  /** Stable machine code, e.g. `service_not_published`. */
  readonly code: string;
  readonly detail: string;
}

const SETTLEMENT_PREFIX = 'kernel_settlement/';
const MAX_SUMMARY_CHARS = 320;
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;

export function formatApplicationSettlement(settlement: KernelApplicationSettlement): string {
  const detail = settlement.detail.replace(/[\r\n]+/gu, ' ').trim();
  const head = `${SETTLEMENT_PREFIX}${settlement.kind}:${settlement.code}`;
  return `${head}${detail ? ` ${detail}` : ''}`.slice(0, MAX_SUMMARY_CHARS);
}

export function parseApplicationSettlement(
  summary: string | null | undefined,
): KernelApplicationSettlement | null {
  if (!summary || !summary.startsWith(SETTLEMENT_PREFIX)) return null;
  const body = summary.slice(SETTLEMENT_PREFIX.length);
  const kindEnd = body.indexOf(':');
  if (kindEnd <= 0) return null;
  const kind = body.slice(0, kindEnd);
  if (kind !== 'rejected_without_effect' && kind !== 'operation_settled') return null;
  const rest = body.slice(kindEnd + 1);
  const space = rest.indexOf(' ');
  const code = space === -1 ? rest : rest.slice(0, space);
  if (!CODE_PATTERN.test(code)) return null;
  return { kind, code, detail: space === -1 ? '' : rest.slice(space + 1) };
}

/** True only for a settlement that proves the Decision created no effect. */
export function isEffectFreeSettlement(summary: string | null | undefined): boolean {
  return parseApplicationSettlement(summary)?.kind === 'rejected_without_effect';
}
