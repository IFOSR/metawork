/**
 * 第三方消费 HTTP 适配器（ADR-0042 §6.1）。
 *
 * 这是 MetaWork 领域端口的一个具体协议适配，不代表第三方已经具备同名 API。
 * 凭据只由可信服务端适配器持有；Executor 不读取该凭据。协议：
 *
 *   POST {baseUrl}/consumption-bills       -> ConsumptionResult JSON
 *   GET  {baseUrl}/consumption-bills/{instanceId}/{billId} -> ConsumptionResult JSON
 *
 * 超时/网络错误抛出，由导出服务转成 `unknown` 并按原键查询，不生成新 billId。
 */

import {
  buildConsumptionBill,
  type ConsumptionBill,
  type ConsumptionResult,
  type ConsumptionResultState,
  type ExternalConsumptionPort,
} from '../billing/consumption-contract.js';

export interface ExternalConsumptionClientOptions {
  readonly baseUrl: string;
  /** 服务端持有的凭据；不来自 Query payload、模型或 Executor。 */
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const RESULT_STATES: readonly ConsumptionResultState[] = [
  'received',
  'applied',
  'rejected',
  'unknown',
];

export function createExternalConsumptionClient(
  options: ExternalConsumptionClientOptions,
): ExternalConsumptionPort {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');

  async function request(path: string, init: RequestInit): Promise<ConsumptionResult> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.bearerToken}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json() as unknown;
    return parseConsumptionResult(body, response.ok);
  }

  return {
    async submitBill(bill: ConsumptionBill): Promise<ConsumptionResult> {
      return request('/consumption-bills', {
        method: 'POST',
        body: JSON.stringify({
          ...bill,
          digest: undefined,
        }),
      });
    },

    async getBillStatus(key): Promise<ConsumptionResult> {
      return request(
        `/consumption-bills/${encodeURIComponent(key.sourceInstanceId)}/${encodeURIComponent(key.billId)}`,
        { method: 'GET' },
      );
    },
  };
}

/**
 * 响应体校验：HTTP 200 不足以表达 confirmed，必须由结构化结果说明状态。
 */
export function parseConsumptionResult(body: unknown, httpOk: boolean): ConsumptionResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error('invalid_consumption_result');
  }
  const record = body as Record<string, unknown>;
  const billId = record.billId;
  const digest = record.digest;
  const state = record.state;
  if (typeof billId !== 'string' || billId.length === 0) {
    throw new Error('invalid_consumption_result_bill_id');
  }
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new Error('invalid_consumption_result_digest');
  }
  if (typeof state !== 'string' || !RESULT_STATES.includes(state as ConsumptionResultState)) {
    throw new Error('invalid_consumption_result_state');
  }
  if (!httpOk && state !== 'rejected' && state !== 'unknown') {
    throw new Error('consumption_result_http_mismatch');
  }
  return {
    billId,
    digest,
    state: state as ConsumptionResultState,
    ...(typeof record.externalEntryId === 'string' ? { externalEntryId: record.externalEntryId } : {}),
    ...(typeof record.appliedAmountMicroCoin === 'string'
      ? { appliedAmountMicroCoin: record.appliedAmountMicroCoin }
      : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

/** 测试与本地对账使用的内存 fake：按原键幂等应用。 */
export function createFakeConsumptionServer(options: {
  readonly amountPrecisionMicroCoin?: boolean;
  readonly failNextSubmit?: 'timeout' | 'http500' | null;
} = {}): ExternalConsumptionPort & {
  readonly applied: Map<string, { amountMicroCoin: string; externalEntryId: string }>;
  readonly received: Set<string>;
  readonly rejected: Map<string, string>;
  setMode(mode: 'apply' | 'receive_only' | 'reject' | 'timeout'): void;
} {
  const applied = new Map<string, { amountMicroCoin: string; externalEntryId: string }>();
  const received = new Set<string>();
  const rejected = new Map<string, string>();
  let mode: 'apply' | 'receive_only' | 'reject' | 'timeout' = 'apply';
  let failNext: 'timeout' | 'http500' | null = options.failNextSubmit ?? null;

  function findBill(billId: string): ConsumptionBill {
    const stored = bills.get(billId);
    if (!stored) throw new Error(`unknown_bill:${billId}`);
    return stored;
  }
  const bills = new Map<string, ConsumptionBill>();

  return {
    applied,
    received,
    rejected,
    setMode(next) {
      mode = next;
    },
    async submitBill(bill) {
      if (failNext === 'timeout') {
        failNext = null;
        throw new Error('timeout');
      }
      if (failNext === 'http500') {
        failNext = null;
        throw new Error('http_500');
      }
      if (mode === 'timeout') throw new Error('timeout');
      const key = `${bill.sourceInstanceId}:${bill.billId}`;
      if (mode === 'reject') {
        rejected.set(key, 'insufficient_funds');
        return {
          billId: bill.billId,
          digest: bill.digest,
          state: 'rejected',
          reason: 'insufficient_funds',
        };
      }
      if (mode === 'receive_only') {
        received.add(key);
        bills.set(bill.billId, bill);
        return { billId: bill.billId, digest: bill.digest, state: 'received' };
      }
      if (applied.has(key)) {
        // 幂等重放：返回既有应用结果。
        const existing = applied.get(key)!;
        bills.set(bill.billId, bill);
        return {
          billId: bill.billId,
          digest: bill.digest,
          state: 'applied',
          externalEntryId: existing.externalEntryId,
          appliedAmountMicroCoin: existing.amountMicroCoin,
        };
      }
      const externalEntryId = `ext_${applied.size + 1}`;
      applied.set(key, { amountMicroCoin: bill.amountMicroCoin, externalEntryId });
      bills.set(bill.billId, bill);
      return {
        billId: bill.billId,
        digest: bill.digest,
        state: 'applied',
        externalEntryId,
        appliedAmountMicroCoin: bill.amountMicroCoin,
      };
    },
    async getBillStatus(key) {
      const bill = findBill(key.billId);
      const composite = `${key.sourceInstanceId}:${key.billId}`;
      if (applied.has(composite)) {
        const existing = applied.get(composite)!;
        return {
          billId: bill.billId,
          digest: bill.digest,
          state: 'applied',
          externalEntryId: existing.externalEntryId,
          appliedAmountMicroCoin: existing.amountMicroCoin,
        };
      }
      if (rejected.has(composite)) {
        return {
          billId: bill.billId,
          digest: bill.digest,
          state: 'rejected',
          reason: rejected.get(composite)!,
        };
      }
      if (received.has(composite)) {
        return { billId: bill.billId, digest: bill.digest, state: 'received' };
      }
      return { billId: bill.billId, digest: bill.digest, state: 'unknown' };
    },
  };
}

export { buildConsumptionBill };
