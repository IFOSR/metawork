/**
 * Gateway 结构化错误契约（ADR-0031 第 8、11 节）。
 *
 * 认证/授权歧义在 Runtime 激活前失败；会话归属错误、忙/冲突/不可用等都以
 * 保留 request 身份的结构化错误返回。过期回放游标返回新快照，不是错误。
 *
 * 纯协议模块：不 import repository / socket / http / planner / kernel /
 * executor 实现。
 */

export type GatewayErrorKind =
  | 'authentication'
  | 'authorization'
  | 'busy'
  | 'conflict'
  | 'unavailable'
  | 'invalid_command';

export interface GatewayError {
  readonly kind: GatewayErrorKind;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

export function gatewayError(
  kind: GatewayErrorKind,
  code: string,
  message: string,
  requestId: string | null = null,
): GatewayError {
  return { kind, code, message, requestId };
}
