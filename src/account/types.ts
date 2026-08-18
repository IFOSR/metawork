/**
 * Account、Principal 与账户命名空间的纯类型契约（ADR-0031）。
 *
 * Principal 是客户端传输层提供的已认证外部身份，绝不自动等同于 Account ID；
 * AccountResolver 通过可信服务端策略把它映射到被授权的 Account。
 *
 * 纯类型模块：不 import 任何 repository / socket / http / planner / kernel /
 * executor。
 */

export type AccountId = string;

export type PrincipalKind = 'local' | 'web' | 'feishu' | 'app';

/** 由客户端传输层提供的已认证外部身份。 */
export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: string;
}

/** 一个 Principal 被授权访问的持久化安全/配置/任务/执行命名空间。 */
export interface Account {
  readonly accountId: AccountId;
}
