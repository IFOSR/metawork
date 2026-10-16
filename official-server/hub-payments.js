import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 of the empty byte string; OPC Hub uses it as BODY_HASH for bodyless requests. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AUTH_CLOCK_CODES = new Set(['OPC_AUTH_INVALID_SIGNATURE', 'OPC_AUTH_TIMESTAMP_OUT_OF_WINDOW', 'OPC_AUTH_NONCE_REPLAY']);
const RETRYABLE_CODES = new Set([
  'OPC_STATE_IDEMPOTENCY_PROCESSING', 'OPC_PAY_CHANNEL_UNAVAILABLE', 'OPC_PAY_CHANNEL_ERROR',
  'OPC_SYS_SERVICE_UNAVAILABLE', 'OPC_SYS_REDIS_UNAVAILABLE', 'OPC_SYS_AUTH_DEPENDENCY_UNAVAILABLE',
]);

export class HubError extends Error {
  constructor(status, code, requestId) { super(code); this.status = status; this.code = code; this.requestId = requestId ?? null; }
  get retryable() { return RETRYABLE_CODES.has(this.code); }
}

/** 7-field canonical request per the OPC Hub authentication spec; bodyHash of '' equals EMPTY_BODY_SHA256. */
export function canonicalHubRequest({ method, path, query = '', body = '', timestamp, nonce, clientId }) {
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  return [String(method).toUpperCase(), path, query, bodyHash, timestamp, nonce, clientId].join('\n');
}

export function signHubRequest(options) {
  return createHmac('sha256', options.clientSecret).update(canonicalHubRequest(options)).digest('hex');
}

/** Verify an OPC Hub outbound notification: ±300000 ms window, gateway-signed with the same algorithm and key. */
export function verifyNotifySignature({ rawBody, headers, path, clientSecret, nowMs = Date.now() }) {
  const clientId = headers?.['x-client-id'];
  const timestamp = headers?.['x-timestamp'];
  const nonce = headers?.['x-nonce'];
  const signature = headers?.['x-signature'];
  if (!clientId || !timestamp || !nonce || !signature) return false;
  const delta = Math.abs(Number(timestamp) - nowMs);
  if (!Number.isFinite(delta) || delta > 300000) return false;
  const expected = signHubRequest({ method: 'POST', path, query: '', body: rawBody ?? '', timestamp, nonce, clientId, clientSecret });
  const expectedBytes = Buffer.from(expected, 'hex');
  const givenBytes = Buffer.from(String(signature), 'hex');
  return expectedBytes.length === givenBytes.length && timingSafeEqual(expectedBytes, givenBytes);
}

/** The documented examples only ever show alphanumerics and hyphens in keys; keep ours inside that set without losing uniqueness. */
function sanitizeIdempotencyKey(key) {
  return String(key).replace(/[^A-Za-z0-9-]/g, '');
}

export function createHubClient({ baseUrl, clientId, clientSecret, notifyUrl, channel = 1, timeoutMs = 15000, fetchImpl = fetch, onClockSkew }) {
  const base = String(baseUrl).replace(/\/+$/u, '');
  let authFailures = 0;
  const noteAuthFailure = code => {
    if (!AUTH_CLOCK_CODES.has(code)) return;
    authFailures += 1;
    if (authFailures >= 3 && authFailures % 3 === 0) onClockSkew?.();
  };

  async function request(method, path, { query = '', body, idempotencyKey, retried = false } = {}) {
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const headers = {
      'X-Client-Id': clientId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signHubRequest({ method, path, query, body: bodyText ?? '', timestamp, nonce, clientId, clientSecret }),
    };
    if (idempotencyKey) headers['Idempotency-Key'] = sanitizeIdempotencyKey(idempotencyKey);
    if (bodyText !== undefined) headers['Content-Type'] = 'application/json';
    let upstream;
    try {
      upstream = await fetchImpl(`${base}${path}${query ? `?${query}` : ''}`, {
        method, headers, redirect: 'error', ...(bodyText === undefined ? {} : { body: bodyText }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HubError(503, 'payment_hub_unreachable');
    }
    if (upstream.status === 429 && !retried) {
      const retryAfter = Number(upstream.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1, 5) * 1000));
      return request(method, path, { query, body, idempotencyKey, retried: true });
    }
    let value = null;
    try { value = await upstream.json(); } catch { value = null; }
    if (!upstream.ok || value?.code !== 'OK') {
      const code = value?.code ?? `http_${upstream.status}`;
      noteAuthFailure(code);
      throw new HubError(upstream.status, code, value?.request_id);
    }
    authFailures = 0;
    return value;
  }

  return {
    async createHubOrder({ amountCents, description, notifyUrl, expireMinutes = 30, idempotencyKey }) {
      const body = { channel, purpose: 2, amount_cents: amountCents, description, expire_minutes: expireMinutes };
      if (notifyUrl) body.notify_url = notifyUrl;
      return (await request('POST', '/v1/payments/orders', { body, idempotencyKey })).order;
    },
    async prepayHubOrder(orderNo, idempotencyKey) {
      return (await request('POST', `/v1/payments/orders/${orderNo}/prepay`, { idempotencyKey })).order;
    },
    async queryHubOrder(orderNo) {
      return (await request('GET', `/v1/payments/orders/${orderNo}`)).order;
    },
    async closeHubOrder(orderNo, idempotencyKey) {
      await request('POST', `/v1/payments/orders/${orderNo}/close`, { idempotencyKey });
    },
    async createHubRefund(orderNo, { amountCents, reason }, idempotencyKey) {
      return (await request('POST', `/v1/payments/orders/${orderNo}/refunds`, { body: { amount_cents: amountCents, reason }, idempotencyKey })).refund;
    },
    async processHubRefund(refundNo, idempotencyKey) {
      await request('POST', `/v1/payments/refunds/${refundNo}/process`, { idempotencyKey });
    },
    async cancelHubRefund(refundNo, idempotencyKey) {
      await request('POST', `/v1/payments/refunds/${refundNo}/cancel`, { idempotencyKey });
    },
    async queryHubRefund(refundNo) {
      return (await request('GET', `/v1/payments/refunds/${refundNo}`)).refund;
    },
    verifyNotify: ({ rawBody, headers, path, nowMs }) =>
      verifyNotifySignature({ rawBody, headers, path, clientSecret, nowMs }),
  };
}
