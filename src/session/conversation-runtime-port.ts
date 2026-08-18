/**
 * Conversation 运行时端口（ADR-0031 第 2 节）。
 *
 * ConversationSession 通过该窄端口访问账户运行时事实与 runtime-wide 服务，
 * 但绝不构造 Kernel / Execution / 恢复服务。类型与
 * `account/account-runtime-ports.ts` 的 ConversationRuntimePort 一致。
 */

export type { ConversationRuntimePort } from '../account/account-runtime-ports.js';
