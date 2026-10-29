/**
 * User-facing text for a Task block reason.
 *
 * Durable facts keep the machine-readable reason (`official authorization
 * state: logged_out`, a Kernel/Executor code, ...). A surface must not print
 * that code at a user who just needs to know what to do about it. Unknown
 * reasons pass through unchanged so a new fact is never silently hidden.
 */

export function userFacingBlockReason(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return '';
  const authorization = /^official authorization state:\s*(\S+)/u.exec(text);
  if (authorization) {
    const state = authorization[1];
    const detail = state === 'logged_out'
      ? '当前未登录'
      : state === 'expired'
        ? '服务权益已到期'
        : state === 'unavailable'
          ? '暂时无法确认权益'
          : `当前状态：${state}`;
    return `需要登录 MetaWork 官方账号后才能继续执行（${detail}）。`;
  }
  if (text.includes('official_authorization_required')) {
    return '需要登录并确认官方账号权益后才能继续执行。';
  }
  return text;
}

/** True when the block is the official-account gate, not a Task/Executor fault. */
export function isOfficialAuthorizationBlock(message: string | null | undefined): boolean {
  const text = (message ?? '').trim();
  return /^official authorization state:/u.test(text) || text.includes('official_authorization_required');
}
