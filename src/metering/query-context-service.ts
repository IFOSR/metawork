/**
 * Query 归因服务（ADR-0042 §2；实施计划 §2.2/§2.4）。
 *
 * - Query 身份在首次可能产生费用的调用前持久化；重传以既有请求幂等身份
 *   复用同一 Query，相同文字的新请求不是重传。
 * - 同一请求键配不同 payload 直接冲突，不允许静默改绑。
 * - Query 到收费 Task 的关联只允许 `null -> 一个 Task`，依据是授权的
 *   Kernel application / execution segment 事实，不随 UI 焦点变化。
 */

import type {
  QueryContextStore,
  QueryIngress,
  QueryTaskLink,
  QueryUsageContext,
} from './ports.js';

export interface BeginQueryInput {
  readonly externalAccountRef?: string | null;
  readonly accountId: string;
  readonly ingress: QueryIngress;
  readonly requestKey: string;
  readonly requestPayloadDigest: string;
  readonly conversationId: string | null;
  readonly requestId: string;
  readonly turnId?: string | null;
  readonly executionSegmentId?: string | null;
  readonly priceBookVersion: string;
  readonly feePolicyVersion: string;
  readonly payerPolicyVersion: string;
  readonly acceptedAt: string;
}

export type BeginQueryResult =
  | { readonly status: 'created' | 'reused'; readonly context: QueryUsageContext }
  | { readonly status: 'conflict'; readonly reason: 'payload_mismatch' };

export type BindTaskResult =
  | { readonly status: 'linked' | 'already_linked'; readonly link: QueryTaskLink }
  | { readonly status: 'conflict'; readonly reason: 'different_cost_task' };

export interface QueryContextServiceDeps {
  readonly store: QueryContextStore;
  readonly createQueryId: (input: BeginQueryInput) => string;
}

export interface QueryContextService {
  beginQuery(input: BeginQueryInput): BeginQueryResult;
  /** 只在 Kernel 授权的应用事实上调用；重复调用幂等。 */
  bindCostTask(input: {
    readonly queryId: string;
    readonly taskId: string;
    readonly decisionId: string;
    readonly basis: QueryTaskLink['basis'];
    readonly linkedAt: string;
  }): BindTaskResult;
  /** 恢复路径只读取持久事实，不读取“当前 Task”。 */
  resolveAttribution(queryId: string): {
    readonly queryId: string;
    readonly costTaskId: string | null;
  };
}

function validateBeginInput(input: BeginQueryInput): void {
  const required: Array<[string, string]> = [
    ['accountId', input.accountId],
    ['requestKey', input.requestKey],
    ['requestPayloadDigest', input.requestPayloadDigest],
    ['requestId', input.requestId],
    ['priceBookVersion', input.priceBookVersion],
    ['feePolicyVersion', input.feePolicyVersion],
    ['payerPolicyVersion', input.payerPolicyVersion],
    ['acceptedAt', input.acceptedAt],
  ];
  for (const [label, value] of required) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`invalid_query_context:${label}`);
    }
  }
}

export function createQueryContextService(
  deps: QueryContextServiceDeps,
): QueryContextService {
  return {
    beginQuery(input) {
      validateBeginInput(input);
      const existing = deps.store.findByIdentity({
        accountId: input.accountId,
        ingress: input.ingress,
        requestKey: input.requestKey,
      });
      if (existing) {
        if (existing.requestPayloadDigest !== input.requestPayloadDigest) {
          return { status: 'conflict', reason: 'payload_mismatch' };
        }
        return { status: 'reused', context: existing };
      }
      const context: QueryUsageContext = Object.freeze({
        externalAccountRef: input.externalAccountRef ?? null,
        queryId: deps.createQueryId(input),
        accountId: input.accountId,
        ingress: input.ingress,
        requestKey: input.requestKey,
        requestPayloadDigest: input.requestPayloadDigest,
        conversationId: input.conversationId,
        requestId: input.requestId,
        turnId: input.turnId ?? null,
        executionSegmentId: input.executionSegmentId ?? null,
        priceBookVersion: input.priceBookVersion,
        feePolicyVersion: input.feePolicyVersion,
        payerPolicyVersion: input.payerPolicyVersion,
        acceptedAt: input.acceptedAt,
      });
      deps.store.insert(context);
      return { status: 'created', context };
    },

    bindCostTask(input) {
      const existing = deps.store.findTaskLink(input.queryId);
      if (existing) {
        return existing.costTaskId === input.taskId
          ? { status: 'already_linked', link: existing }
          : { status: 'conflict', reason: 'different_cost_task' };
      }
      const link: QueryTaskLink = Object.freeze({
        queryId: input.queryId,
        costTaskId: input.taskId,
        decisionId: input.decisionId,
        basis: input.basis,
        linkedAt: input.linkedAt,
      });
      const outcome = deps.store.linkTask(link);
      if (outcome === 'conflict') {
        return { status: 'conflict', reason: 'different_cost_task' };
      }
      return { status: outcome, link };
    },

    resolveAttribution(queryId) {
      const link = deps.store.findTaskLink(queryId);
      return { queryId, costTaskId: link?.costTaskId ?? null };
    },
  };
}
