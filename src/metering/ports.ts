/**
 * 计量持久化端口（ADR-0042 §7.1、§7.2）。
 *
 * `src/metering/` 定义端口，`src/storage/` 提供 SQLite 实现。端口本身不决定
 * 调度、不创建 Task、不操作钱包。
 */

import type { Payer } from '../billing/cost-policy.js';
import type { BillingResource } from '../billing/pricing.js';
import type { MeteringReason, MeteringStage, SourceScope, UsageQuality } from './contracts.js';
import type { CumulativeSnapshot, NormalizationIssue } from './usage-normalizer.js';

export const QUERY_INGRESSES = ['web', 'feishu', 'tui', 'cli', 'system'] as const;
export type QueryIngress = (typeof QUERY_INGRESSES)[number];

/**
 * 一个 Query 的持久归因上下文。`priceBookVersion` / `feePolicyVersion` /
 * `payerPolicyVersion` 在接受时固定，所有自动 retry 沿用同一版本。
 */
export interface QueryUsageContext {
  readonly externalAccountRef?: string | null;
  readonly queryId: string;
  readonly accountId: string;
  readonly ingress: QueryIngress;
  /** 账户与入口作用域内的请求幂等键；与 payload digest 一起判定重传。 */
  readonly requestKey: string;
  readonly requestPayloadDigest: string;
  readonly conversationId: string | null;
  readonly requestId: string;
  readonly turnId: string | null;
  readonly executionSegmentId: string | null;
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly payerPolicyVersion: string;
  readonly acceptedAt: string;
}

export interface QueryTaskLink {
  readonly queryId: string;
  readonly costTaskId: string;
  /** 授权的 Kernel application / decision 事实；不得来自 UI 焦点。 */
  readonly decisionId: string;
  readonly basis: 'authorized_application' | 'authorized_execution_segment';
  readonly linkedAt: string;
}

export interface ExecutionUsageContext {
  readonly executionSegmentId: string;
  readonly queryId: string;
  readonly kind: 'planner_run' | 'task_generation' | 'attempt' | 'resume_segment';
  readonly referenceId: string;
  readonly taskId: string | null;
  readonly recordedAt: string;
}

export interface MeteringSpanRecord {
  readonly spanId: string;
  readonly queryId: string;
  readonly executionSegmentId: string | null;
  readonly sourceId: string;
  readonly sourceScope: SourceScope;
  readonly callId: string;
  readonly stage: MeteringStage | null;
  readonly reason: MeteringReason;
  readonly state: 'started' | 'closed' | 'uncertain';
  readonly payer: Payer;
  readonly startedAt: string;
  readonly closedAt: string | null;
}

export interface PersistedUsageObservation {
  readonly cumulativeValue?: string | null;
  readonly observationId: string;
  readonly spanId: string | null;
  readonly sourceId: string;
  readonly sourceEventKey: string;
  readonly sourceScope: SourceScope;
  readonly callId: string;
  readonly queryId: string;
  readonly executionSegmentId: string | null;
  readonly taskId: string | null;
  readonly stage: MeteringStage | null;
  readonly reason: MeteringReason;
  readonly resource: BillingResource;
  readonly metric: string;
  readonly unit: string;
  readonly quantityNumerator: string;
  readonly quantityDenominator: string;
  readonly quality: UsageQuality;
  readonly countsTowardTotal: boolean;
  readonly payer: Payer;
  readonly agentClassRef?: string | null;
  readonly providerRef?: string | null;
  readonly modelId?: string | null;
  readonly capturedAt: string;
  readonly providerBindingVersion: string | null;
  readonly evidenceRef: string | null;
  readonly normalizationRuleVersion: string;
}

/** 已持久观测的精确数量。 */
export function persistedObservationQuantity(
  observation: PersistedUsageObservation,
): { numerator: bigint; denominator: bigint } {
  return {
    numerator: BigInt(observation.quantityNumerator),
    denominator: BigInt(observation.quantityDenominator),
  };
}

export interface QueryContextStore {
  findById(queryId: string): QueryUsageContext | null;
  findByTurnId(accountId: string, turnId: string): QueryUsageContext | null;
  findByIdentity(input: {
    accountId: string;
    ingress: QueryIngress;
    requestKey: string;
  }): QueryUsageContext | null;
  insert(context: QueryUsageContext): void;
  findTaskLink(queryId: string): QueryTaskLink | null;
  linkTask(link: QueryTaskLink): 'linked' | 'already_linked' | 'conflict';
  listQueryIdsForTask(taskId: string): string[];
  recordExecutionContext(context: ExecutionUsageContext): void;
  listExecutionContexts(queryId: string): ExecutionUsageContext[];
}

export interface MeteringStore {
  openSpan(span: MeteringSpanRecord): void;
  closeSpan(spanId: string, state: 'closed' | 'uncertain', closedAt: string): boolean;
  listOpenSpans(queryId: string): MeteringSpanRecord[];
  listSpans(queryId: string): MeteringSpanRecord[];
  insertObservations(observations: readonly PersistedUsageObservation[]): number;
  listObservations(queryId: string): PersistedUsageObservation[];
  listCumulativeSnapshots(sourceIds: readonly string[]): CumulativeSnapshot[];
  recordIssues(issues: readonly (NormalizationIssue & { queryId: string })[]): void;
}
