import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { addCalendarMonths, centsToYuan, parseHubDatetime, refundRestoreRevision, settlementExpiry, yuanToCents } from '../business.js';
import { canonicalHubRequest, EMPTY_BODY_SHA256, signHubRequest } from '../hub-payments.js';

let child, root, db, base, upstream;
let tokenA, tokenB, accountA, upstreamCalls = 0, upstreamBody, release, held;
let upstreamResult, upstreamStatus = 200, upstreamFinishReason = 'stop', diagnostics = '';
const admin = 'test-admin-token-'.repeat(4);
const hubClientId = 'aabbccdd11223344aabbccdd11223344';
const hubSecret = 'hub-test-secret';
const notifyUrl = 'https://notify.example.test/v1/payments/notify';
let hub, hubCalls = [];
const hubOrders = new Map(), hubOverrides = new Map(), hubRefunds = new Map(), hubRefundStatus = new Map(), hubIdempotency = new Map();
let hubFailNext = null;
let payB = null;
const rewrite = { mission: '分析项目', tasks: ['实现功能'], deliverables: ['代码变更'], quality: ['核验结果'], boundaries: ['遵守授权'] };
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function api(path, body, token) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'metawork-official-test-'));
  upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks)); upstreamCalls++;
    if (held) await held;
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'private-model', usage: { total_tokens: 9 }, choices: [{ finish_reason: upstreamFinishReason, message: { content: JSON.stringify(upstreamResult ?? rewrite) } }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  // OPC Hub stub: verifies the client signature by recomputation and serves scripted order/refund states.
  hub = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://hub');
    const body = raw.length ? JSON.parse(raw.toString()) : null;
    hubCalls.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const fail = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, message: code })); };
    const ok = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'OK', message: 'OK', request_id: randomBytes(8).toString('hex'), timestamp: '2026-06-16 10:00:00', ...payload })); };
    const expected = signHubRequest({ method: req.method, path: url.pathname, query: url.search.replace(/^\?/u, ''), body: raw, timestamp: req.headers['x-timestamp'], nonce: req.headers['x-nonce'], clientId: hubClientId, clientSecret: hubSecret });
    if (req.headers['x-signature'] !== expected) return fail(401, 'OPC_AUTH_INVALID_SIGNATURE');
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey && hubIdempotency.has(idempotencyKey)) return ok(hubIdempotency.get(idempotencyKey));
    const respond = payload => { if (idempotencyKey) hubIdempotency.set(idempotencyKey, payload); return ok(payload); };
    if (req.method === 'POST' && url.pathname === '/v1/payments/orders') {
      const orderNo = randomBytes(16).toString('hex');
      const order = { order_no: orderNo, status: 1, amount_cents: body.amount_cents, currency: 'CNY', description: body.description, expire_time: '2026-06-16 10:30:00', paid_time: null, channel_order_no: null, channel_paid_amount: null, refunded_amount_cents: 0, qr_code_url: null, pay_params: null };
      hubOrders.set(orderNo, order);
      return respond({ order });
    }
    const prepay = /^\/v1\/payments\/orders\/([0-9a-f]+)\/prepay$/u.exec(url.pathname);
    if (req.method === 'POST' && prepay) {
      const order = hubOrders.get(prepay[1]);
      if (!order) return fail(404, 'OPC_PAY_ORDER_NOT_FOUND');
      if (hubFailNext === 'prepay-cannot') { hubFailNext = null; return fail(400, 'OPC_PAY_ORDER_CANNOT_PREPAY'); }
      order.status = 2;
      order.qr_code_url = `weixin://wxpay/bizpayurl?pr=${prepay[1].slice(0, 12)}`;
      return ok({ order });
    }
    const detail = /^\/v1\/payments\/orders\/([0-9a-f]+)$/u.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const order = hubOrders.get(detail[1]);
      if (!order) return fail(404, 'OPC_PAY_ORDER_NOT_FOUND');
      return ok({ order: { ...order, ...(hubOverrides.get(detail[1]) ?? {}) } });
    }
    const close = /^\/v1\/payments\/orders\/([0-9a-f]+)\/close$/u.exec(url.pathname);
    if (req.method === 'POST' && close) {
      const order = hubOrders.get(close[1]);
      if ((hubOverrides.get(close[1])?.status ?? order?.status) === 3) return fail(400, 'OPC_PAY_ORDER_CANNOT_CLOSE');
      if (order) order.status = 5;
      return ok({});
    }
    const createRefund = /^\/v1\/payments\/orders\/([0-9a-f]+)\/refunds$/u.exec(url.pathname);
    if (req.method === 'POST' && createRefund) {
      if (hubFailNext === 'create-refund') { hubFailNext = null; return fail(503, 'OPC_SYS_SERVICE_UNAVAILABLE'); }
      const refundNo = randomBytes(16).toString('hex');
      const refund = { refund_no: refundNo, order_no: createRefund[1], channel_refund_no: null, original_amount_cents: hubOrders.get(createRefund[1])?.amount_cents ?? 990, amount_cents: body.amount_cents, reason: body.reason, status: 1, refunded_time: null };
      hubRefunds.set(refundNo, refund);
      return respond({ refund });
    }
    const processRefund = /^\/v1\/payments\/refunds\/([0-9a-f]+)\/process$/u.exec(url.pathname);
    if (req.method === 'POST' && processRefund) {
      const refund = hubRefunds.get(processRefund[1]);
      if (!refund) return fail(404, 'OPC_PAY_REFUND_NOT_FOUND');
      refund.status = 2;
      return ok({});
    }
    const cancelRefund = /^\/v1\/payments\/refunds\/([0-9a-f]+)\/cancel$/u.exec(url.pathname);
    if (req.method === 'POST' && cancelRefund) {
      const refund = hubRefunds.get(cancelRefund[1]);
      if (!refund) return fail(404, 'OPC_PAY_REFUND_NOT_FOUND');
      if (refund.status !== 1) return fail(400, 'OPC_PAY_REFUND_CANNOT_CANCEL');
      refund.status = 5;
      return ok({});
    }
    const refundDetail = /^\/v1\/payments\/refunds\/([0-9a-f]+)$/u.exec(url.pathname);
    if (req.method === 'GET' && refundDetail) {
      const refund = hubRefunds.get(refundDetail[1]);
      if (!refund) return fail(404, 'OPC_PAY_REFUND_NOT_FOUND');
      return ok({ refund: { ...refund, ...(hubRefundStatus.get(refundDetail[1]) ?? {}) } });
    }
    return fail(404, 'not_found');
  });
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test.sqlite'), ADMIN_TOKEN: admin, MODEL_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MODEL_API_KEY: 'test-private-key', MODEL_ID: 'private-model', MODEL_THINKING: 'ignored-legacy-setting', AI_DAILY_GLOBAL_LIMIT: 'ignored-legacy-setting', NODE_ENV: 'test', HTTP_RATE_MAX: '100000', AUTH_RATE_MAX: '100000', EMAIL_RATE_MAX: '100000', ORDERS_RATE_MAX: '100000', PAY_RATE_MAX: '100000', PAYMENT_HUB_BASE_URL: `http://127.0.0.1:${hub.address().port}`, PAYMENT_HUB_CLIENT_ID: hubClientId, PAYMENT_HUB_CLIENT_SECRET: hubSecret, PAYMENT_NOTIFY_URL: notifyUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => child.once('exit', () => reject(new Error('Service exited'))))]);
  db = new DatabaseSync(join(root, 'test.sqlite'));
});
after(async () => {
  if (child) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]); }
  db?.close();
  await new Promise(resolve => upstream?.close(resolve));
  await new Promise(resolve => hub?.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => {});
});
async function whenExited(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  await Promise.race([once(proc, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
}

async function registerLogin(email) {
  await api('/v1/auth/register', { email, password: 'test-password-12345' }).catch(() => {});
  const login = await api('/v1/auth/login', { email, password: 'test-password-12345' });
  assert.equal(login.status, 200);
  return { token: login.body.sessionToken, accountId: login.body.account.accountId };
}
function markHubPaid(orderNo, channelOrderNo = 'wx-tx-1') {
  const order = hubOrders.get(orderNo);
  hubOverrides.set(orderNo, { status: 3, channel_order_no: channelOrderNo, paid_time: '2026-06-16 10:05:00', channel_paid_amount: order.amount_cents });
}
async function notifyPaid(orderNo, amountCents, signature = null) {
  const epoch = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ event_type: 'PAYMENT.PAID', order_no: orderNo, amount_cents: amountCents, paid_time: new Date(epoch * 1000).toISOString(), paid_time_epoch: epoch });
  const timestamp = String(Date.now());
  const nonce = `nonce-${randomBytes(8).toString('hex')}`;
  const headers = {
    'Content-Type': 'application/json', 'X-Client-Id': hubClientId, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
    'X-Signature': signature ?? signHubRequest({ method: 'POST', path: '/v1/payments/notify', query: '', body: raw, timestamp, nonce, clientId: hubClientId, clientSecret: hubSecret }),
  };
  const response = await fetch(`${base}/v1/payments/notify`, { method: 'POST', headers, body: raw });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('calendar subscriptions clamp month ends and leap days', () => {
  assert.equal(addCalendarMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addCalendarMonths('2028-02-29T10:00:00.000Z', 12), '2029-02-28T10:00:00.000Z');
});
test('public registration, opaque login and no persisted plaintext tokens/passwords', async () => {
  for (const email of ['a@example.com', 'b@example.com']) {
    assert.equal((await api('/v1/auth/register', { email, password: 'test-password-12345' })).status, 201);
    const login = await api('/v1/auth/login', { email, password: 'test-password-12345' });
    assert.equal(login.status, 200); assert.equal(login.body.entitlement.status, 'unknown');
    if (email.startsWith('a')) { tokenA = login.body.sessionToken; accountA = login.body.account.accountId; }
    else tokenB = login.body.sessionToken;
  }
  const rows = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  assert.ok(!rows.includes(tokenA)); assert.ok(!JSON.stringify(db.prepare('SELECT * FROM accounts').all()).includes('test-password-12345'));
  assert.equal((await api('/v1/auth/login', { email: 'a@example.com', password: 'incorrect-password' })).status, 401);
});
test('pending payment never grants rights; idempotency is account scoped and checks payload', async () => {
  const order = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'same-key-123', amountCny: '0.01' }, tokenA);
  assert.equal(order.body.amountCny, '9.90'); assert.equal(order.body.status, 'pending_payment');
  const other = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'same-key-123' }, tokenB);
  assert.notEqual(order.body.orderId, other.body.orderId);
  assert.equal((await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'same-key-123' }, tokenA)).body.orderId, order.body.orderId);
  assert.equal((await api('/v1/orders', { plan: 'annual', idempotencyKey: 'same-key-123' }, tokenA)).status, 409);
  assert.equal((await api('/v1/entitlement', undefined, tokenA)).body.entitlement.status, 'pending_payment');
  assert.equal((await api('/v1/ai/operation', {}, tokenA)).status, 402);
});
test('trial activation is atomic, once per account, and has a seven day expiry', async () => {
  const trials = await Promise.all(['trial-key-111', 'trial-key-222'].map(idempotencyKey => api('/v1/orders', { plan: 'trial', idempotencyKey }, tokenA)));
  assert.deepEqual(trials.map(item => item.status).sort(), [201, 409]);
  const fact = (await api('/v1/entitlement', undefined, tokenA)).body.entitlement;
  assert.equal(fact.status, 'trial'); assert.ok(Math.abs(Date.parse(fact.expiresAt) - Date.parse(fact.effectiveAt) - 7 * 86400000) < 1000);
  assert.equal(db.prepare("SELECT count(*) AS n FROM licenses WHERE account_id = ? AND plan = 'trial'").get(accountA).n, 1);
});
const aiInput = { operation: 'responsibility_rewrite', requestId: 'rewrite-request-1', input: { agentClassRef: 'engineer', sourceText: '代码分析', intent: '', modelFacts: [] } };
test('fixed AI uses provider defaults and retries the same request without quota gates', async () => {
  const result = await api('/v1/ai/operation', { ...aiInput, system: 'caller system', model: 'caller model' }, tokenA);
  assert.equal(result.status, 200); assert.deepEqual(result.body.result, rewrite);
  assert.equal(result.body.entitlement.status, 'trial');
  assert.equal(result.body.model, undefined); assert.equal(result.body.usage, undefined);
  assert.equal(upstreamBody.model, 'private-model');
  assert.ok(upstreamBody.messages[0].content.includes('职责编辑助手'));
  assert.equal(upstreamBody.max_tokens, undefined);
  assert.equal(upstreamBody.thinking, undefined);
  assert.equal(upstreamBody.temperature, undefined);
  // Historical usage cannot become a daily admission gate.
  const insert = db.prepare('INSERT INTO ai_usage VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 1001; i++) insert.run(`historical-${i}`, accountA, 'model_summary', new Date().toISOString());
  // Cross both the former six-call AI limit and the shared HTTP limit.
  for (let i = 0; i < 125; i++) assert.equal((await api('/v1/ai/operation', aiInput, tokenA)).status, 200);
  const audit = db.prepare('SELECT count(*) AS n FROM ai_usage WHERE account_id=?').get(accountA);
  assert.equal(audit.n, 1127);
});
test('AI accepts client business data and returns JSON without duplicate schema or name filters', async () => {
  const calls = upstreamCalls;
  assert.equal((await api('/v1/ai/operation', { operation: 'unknown', input: {} }, tokenA)).status, 400);
  assert.equal((await api('/v1/ai/operation', { operation: '__proto__', input: {} }, tokenA)).status, 400);
  assert.equal(upstreamCalls, calls);
  try {
    upstreamResult = { summary: 'private-model', futureField: 'x'.repeat(140000), boundaries: [{ description: '由本地业务消费者解释。' }] };
    upstreamFinishReason = 'length';
    const result = await api('/v1/ai/operation', {
      operation: 'model_summary', input: { modelId: 'public-model', source: 'x'.repeat(80000), futureClientField: true },
    }, tokenA);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.result, upstreamResult);
    assert.equal(result.body.model, undefined);
    assert.equal(result.body.usage, undefined);
    assert.equal(JSON.parse(upstreamBody.messages[1].content).futureClientField, true);
    upstreamStatus = 502;
    const failed = await api('/v1/ai/operation', aiInput, tokenA);
    assert.equal(failed.status, 503); assert.deepEqual(failed.body, { code: 'official_ai_unavailable' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(diagnostics.includes('upstream_status'));
    assert.ok(!diagnostics.includes('private-model')); assert.ok(!diagnostics.includes('test-private-key'));
  } finally { upstreamResult = undefined; upstreamFinishReason = 'stop'; upstreamStatus = 200; }
});
test('concurrent AI is allowed; logout still fences all in-flight results', async () => {
  held = new Promise(resolve => { release = resolve; });
  const calls = upstreamCalls;
  const pending = Array.from({ length: 5 }, () => api('/v1/ai/operation', aiInput, tokenA));
  try {
    const deadline = Date.now() + 5000;
    while (upstreamCalls < calls + 5) {
      assert.ok(Date.now() < deadline, 'Concurrent calls did not reach upstream');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await api('/v1/auth/logout', {}, tokenA)).status, 204);
  } finally { release(); held = null; }
  assert.deepEqual((await Promise.all(pending)).map(result => result.status), [401, 401, 401, 401, 401]);
  assert.equal((await api('/v1/entitlement', undefined, tokenA)).status, 401);
});
test('admin issuance requires a secret and only grants internal perpetual licenses', async () => {
  assert.equal((await api('/v1/admin/licenses', { accountId: accountA, plan: 'internal_perpetual' })).status, 401);
  assert.equal((await api('/v1/admin/licenses', { accountId: accountA, plan: 'monthly' }, admin)).status, 400);
  const result = await api('/v1/admin/licenses', { accountId: accountA, plan: 'internal_perpetual' }, admin);
  assert.equal(result.body.entitlement.plan, 'internal_perpetual'); assert.equal(result.body.entitlement.revision, 2);
  assert.equal((await api('/v1/admin/revoke', { accountId: accountA }, admin)).status, 200);
  assert.equal(db.prepare('SELECT status FROM licenses WHERE account_id = ? ORDER BY revision DESC LIMIT 1').get(accountA).status, 'revoked');
});
test('oversized bodies and malformed JSON are rejected with safe errors', async () => {
  assert.equal((await api('/v1/orders', { data: 'x'.repeat(66000) }, tokenB)).status, 413);
  const response = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { code: 'invalid_json' });
});
test('pure money, hub time and refund restore helpers follow the settlement contract', () => {
  assert.equal(yuanToCents('9.90'), 990);
  assert.equal(centsToYuan(990), '9.90');
  assert.equal(parseHubDatetime('2026-06-16 10:30:00'), '2026-06-16T02:30:00.000Z');
  assert.equal(parseHubDatetime('bad'), null);
  assert.equal(EMPTY_BODY_SHA256, createHash('sha256').update('').digest('hex'));
  const canonical = canonicalHubRequest({ method: 'get', path: '/v1/payments/orders', query: 'page=1&page_size=20&status=3', body: '', timestamp: '1718500000000', nonce: 'test-nonce-12345', clientId: hubClientId });
  assert.deepEqual(canonical.split('\n'), ['GET', '/v1/payments/orders', 'page=1&page_size=20&status=3', EMPTY_BODY_SHA256, '1718500000000', 'test-nonce-12345', hubClientId]);
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  assert.equal(settlementExpiry({ plan: 'monthly', paidAt: new Date().toISOString(), currentEntitlement: { plan: 'monthly', status: 'active', effectiveAt: new Date().toISOString(), expiresAt: future } }), addCalendarMonths(future, 1));
  assert.equal(settlementExpiry({ plan: 'annual', paidAt: '2026-01-31T10:00:00.000Z', currentEntitlement: { plan: 'monthly', status: 'expired', effectiveAt: '2025-12-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' } }), '2027-01-31T10:00:00.000Z');
  assert.equal(settlementExpiry({ plan: 'monthly', paidAt: '2026-01-31T10:00:00.000Z', currentEntitlement: null }), '2026-02-28T10:00:00.000Z');
  assert.deepEqual(refundRestoreRevision([
    { id: 'l1', revision: 1, plan: 'trial', status: 'revoked', effective_at: null, expires_at: null },
    { id: 'l2', revision: 2, plan: 'monthly', status: 'active', effective_at: null, expires_at: '2026-08-01T00:00:00.000Z' },
  ], 'l2'), { plan: 'trial', status: 'revoked', expiresAt: null });
  assert.deepEqual(refundRestoreRevision([{ id: 'l1', revision: 1, plan: 'monthly', status: 'active', effective_at: null, expires_at: 'x' }], 'l1'), { plan: 'monthly', status: 'revoked', expiresAt: null });
  assert.equal(refundRestoreRevision([{ id: 'l1', revision: 1, plan: 'monthly', status: 'active', effective_at: null, expires_at: 'x' }], 'missing'), null);
});
test('pay creates a signed hub order and the notify settles it exactly once', async () => {
  const { token, accountId } = await registerLogin('pay-a@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0001' }, token);
  assert.equal(created.status, 201);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  assert.equal(pay.status, 200);
  assert.ok(pay.body.payment.qrCodeUrl.startsWith('weixin://'));
  assert.equal(pay.body.payment.status, 'pending');
  const hubOrderNo = pay.body.payment.hubOrderNo;
  const create = hubCalls.find(call => call.path === '/v1/payments/orders');
  assert.equal(create.body.channel, 1); assert.equal(create.body.purpose, 2); assert.equal(create.body.amount_cents, 990);
  assert.equal(create.body.notify_url, notifyUrl);
  assert.equal(create.headers['idempotency-key'], `pay-${orderId}`.replace(/_/gu, ''));
  assert.equal((await notifyPaid(hubOrderNo, 990, 'f'.repeat(64))).status, 401);
  markHubPaid(hubOrderNo);
  assert.equal((await notifyPaid(hubOrderNo, 990)).status, 200);
  const fact = (await api('/v1/entitlement', undefined, token)).body.entitlement;
  assert.equal(fact.status, 'active'); assert.equal(fact.plan, 'monthly');
  const licenseCount = () => db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n;
  assert.equal(licenseCount(), 1);
  await notifyPaid(hubOrderNo, 990);
  assert.equal(licenseCount(), 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  const paidRow = db.prepare('SELECT * FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo);
  assert.equal(paidRow.status, 'paid'); assert.ok(paidRow.granted_license_id); assert.equal(paidRow.channel_order_no, 'wx-tx-1');
  // In-period renewal extends from the current expiry, not from the payment time.
  const renewal = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0002' }, token);
  const renewalPay = await api(`/v1/orders/${renewal.body.orderId}/pay`, {}, token);
  markHubPaid(renewalPay.body.payment.hubOrderNo);
  await notifyPaid(renewalPay.body.payment.hubOrderNo, 990);
  const renewed = (await api('/v1/entitlement', undefined, token)).body.entitlement;
  assert.equal(Date.parse(renewed.expiresAt), Date.parse(addCalendarMonths(fact.expiresAt, 1)));
  assert.equal(licenseCount(), 2);
});
test('a stale attempt paid after close still settles; a second paid attempt only opens a duplicate incident', async () => {
  const { token, accountId } = await registerLogin('pay-b@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0003' }, token);
  const orderId = created.body.orderId;
  const first = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const firstNo = first.body.payment.hubOrderNo;
  hubFailNext = 'prepay-cannot';
  const second = await api(`/v1/orders/${orderId}/pay`, {}, token);
  assert.equal(second.status, 200);
  const secondNo = second.body.payment.hubOrderNo;
  assert.notEqual(firstNo, secondNo);
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(firstNo).status, 'closed');
  markHubPaid(firstNo);
  await notifyPaid(firstNo, 990);
  assert.equal((await api('/v1/entitlement', undefined, token)).body.entitlement.status, 'active');
  const licenses = db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n;
  markHubPaid(secondNo);
  await notifyPaid(secondNo, 990);
  assert.equal(db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n, licenses);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'duplicate_payment'").get(secondNo));
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(secondNo).status, 'paid');
  payB = { token, orderId, secondNo };
});
test('amount mismatch, unknown orders and disabled accounts become incidents, never rights', async () => {
  const { token, accountId } = await registerLogin('pay-c@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0004' }, token);
  const pay = await api(`/v1/orders/${created.body.orderId}/pay`, {}, token);
  markHubPaid(pay.body.payment.hubOrderNo);
  await notifyPaid(pay.body.payment.hubOrderNo, 100);
  assert.equal(db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n, 0);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'amount_mismatch'").get(pay.body.payment.hubOrderNo));
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(pay.body.payment.hubOrderNo).status, 'paid');
  await notifyPaid(pay.body.payment.hubOrderNo, 100);
  assert.equal(db.prepare("SELECT count(*) AS n FROM payment_incidents WHERE hub_order_no = ? AND kind = 'amount_mismatch'").get(pay.body.payment.hubOrderNo).n, 1);
  await notifyPaid(randomBytes(16).toString('hex'), 990);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE kind = 'unknown_order'").get());
  const other = await registerLogin('pay-d@example.com');
  const disabledOrder = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0005' }, other.token);
  const disabledPay = await api(`/v1/orders/${disabledOrder.body.orderId}/pay`, {}, other.token);
  assert.equal((await api('/v1/admin/revoke', { accountId: other.accountId, disable: true }, admin)).status, 200);
  markHubPaid(disabledPay.body.payment.hubOrderNo);
  await notifyPaid(disabledPay.body.payment.hubOrderNo, 990);
  assert.equal(db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(other.accountId).n, 0);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'disabled_account_paid'").get(disabledPay.body.payment.hubOrderNo));
});
test('order polling reconciles paid state from the hub and throttles hub queries', async () => {
  const { token } = await registerLogin('pay-e@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0006' }, token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const hubOrderNo = pay.body.payment.hubOrderNo;
  const detailCalls = () => hubCalls.filter(call => call.method === 'GET' && call.path === `/v1/payments/orders/${hubOrderNo}`).length;
  assert.equal((await api(`/v1/orders/${orderId}`, undefined, token)).status, 200);
  await api(`/v1/orders/${orderId}`, undefined, token);
  assert.equal(detailCalls(), 1);
  await new Promise(resolve => setTimeout(resolve, 5100));
  markHubPaid(hubOrderNo, 'wx-tx-2');
  const view = await api(`/v1/orders/${orderId}`, undefined, token);
  assert.equal(view.body.order.status, 'paid');
  assert.equal(view.body.payment.status, 'paid');
  assert.equal(detailCalls(), 2);
});
test('money arriving after the order was closed becomes an incident and is refundable', async () => {
  const { token, accountId } = await registerLogin('pay-f@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0007' }, token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const hubOrderNo = pay.body.payment.hubOrderNo;
  assert.equal((await api('/v1/admin/orders/close', { orderId }, admin)).status, 200);
  assert.equal((await api('/v1/entitlement', undefined, token)).body.entitlement.status, 'unknown');
  markHubPaid(hubOrderNo);
  await notifyPaid(hubOrderNo, 990);
  assert.equal(db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n, 0);
  const incident = db.prepare("SELECT * FROM payment_incidents WHERE hub_order_no = ? AND kind = 'paid_after_closed_order'").get(hubOrderNo);
  assert.ok(incident);
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo).status, 'paid');
  const refund = await api('/v1/admin/refunds', { orderId, hubOrderNo, reason: '关闭后到账退款' }, admin);
  assert.equal(refund.status, 201);
  hubRefundStatus.set(refund.body.refund.refundNo, { status: 3, channel_refund_no: 'rf-1', refunded_time: '2026-06-16 10:15:00' });
  const done = await api('/v1/admin/refunds/query', { refundNo: refund.body.refund.refundNo }, admin);
  assert.equal(done.body.refund.status, 'succeeded');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo).status, 'refunded');
  assert.equal(db.prepare('SELECT resolved FROM payment_incidents WHERE incident_id = ?').get(incident.incident_id).resolved, 1);
});
test('admin refund restores the pre-purchase entitlement; duplicate and newer-revision cases stay manual', async () => {
  const first = await registerLogin('pay-g@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0008' }, first.token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, first.token);
  markHubPaid(pay.body.payment.hubOrderNo);
  await notifyPaid(pay.body.payment.hubOrderNo, 990);
  const refunded = await api('/v1/admin/refunds', { orderId, reason: '用户要求退款' }, admin);
  assert.equal(refunded.status, 201);
  hubRefundStatus.set(refunded.body.refund.refundNo, { status: 3, channel_refund_no: 'rf-2', refunded_time: '2026-06-16 10:20:00' });
  const done = await api('/v1/admin/refunds/query', { refundNo: refunded.body.refund.refundNo }, admin);
  assert.equal(done.body.refund.status, 'succeeded');
  assert.equal(done.body.refund.entitlementRestored, true);
  // 重复对账（sweep + 手动查询）不得二次应用恢复或污染 manual_required
  const repeated = await api('/v1/admin/refunds/query', { refundNo: refunded.body.refund.refundNo }, admin);
  assert.equal(repeated.body.refund.status, 'succeeded');
  assert.equal(repeated.body.refund.entitlementRestored, true);
  assert.equal(repeated.body.refund.manualRequired, null);
  assert.equal((await api('/v1/entitlement', undefined, first.token)).body.entitlement.status, 'revoked');
  assert.equal((await api('/v1/entitlement', undefined, first.token)).body.entitlement.status, 'revoked');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(pay.body.payment.hubOrderNo).status, 'refunded');
  // Renewal refund restores the previous revision's expiry (decision row 1 with a previous revision).
  const second = await registerLogin('pay-h@example.com');
  const baseOrder = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0009' }, second.token);
  const basePay = await api(`/v1/orders/${baseOrder.body.orderId}/pay`, {}, second.token);
  markHubPaid(basePay.body.payment.hubOrderNo);
  await notifyPaid(basePay.body.payment.hubOrderNo, 990);
  const baseExpiry = (await api('/v1/entitlement', undefined, second.token)).body.entitlement.expiresAt;
  const renewal = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0010' }, second.token);
  const renewalPay = await api(`/v1/orders/${renewal.body.orderId}/pay`, {}, second.token);
  markHubPaid(renewalPay.body.payment.hubOrderNo);
  await notifyPaid(renewalPay.body.payment.hubOrderNo, 990);
  const refundRenewal = await api('/v1/admin/refunds', { orderId: renewal.body.orderId, reason: '续费退款' }, admin);
  hubRefundStatus.set(refundRenewal.body.refund.refundNo, { status: 3, refunded_time: '2026-06-16 10:25:00' });
  const renewalDone = await api('/v1/admin/refunds/query', { refundNo: refundRenewal.body.refund.refundNo }, admin);
  assert.equal(renewalDone.body.refund.entitlementRestored, true);
  assert.equal((await api('/v1/entitlement', undefined, second.token)).body.entitlement.expiresAt, baseExpiry);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(renewal.body.orderId).status, 'refunded');
  // Duplicate attempt money refunds without touching rights (decision row 3), by explicit hub order number.
  const dupRefund = await api('/v1/admin/refunds', { orderId: payB.orderId, hubOrderNo: payB.secondNo, reason: '重复支付退款' }, admin);
  assert.equal(dupRefund.status, 201);
  hubRefundStatus.set(dupRefund.body.refund.refundNo, { status: 3, refunded_time: '2026-06-16 10:30:00' });
  const dupDone = await api('/v1/admin/refunds/query', { refundNo: dupRefund.body.refund.refundNo }, admin);
  assert.equal(dupDone.body.refund.status, 'succeeded');
  assert.equal(dupDone.body.refund.manualRequired, 'duplicate_attempt_refunded');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(payB.orderId).status, 'paid');
  const rightsAfter = (await api('/v1/entitlement', undefined, payB.token)).body.entitlement;
  assert.equal(rightsAfter.status, 'active');
  assert.equal(db.prepare('SELECT resolved FROM payment_incidents WHERE hub_order_no = ? AND kind = ?').get(payB.secondNo, 'duplicate_payment').resolved, 1);
  // Newer revision (decision row 2): refund the old anchor after an internal perpetual grant.
  const newer = await registerLogin('pay-i@example.com');
  const newerOrder = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0012' }, newer.token);
  const newerPay = await api(`/v1/orders/${newerOrder.body.orderId}/pay`, {}, newer.token);
  markHubPaid(newerPay.body.payment.hubOrderNo);
  await notifyPaid(newerPay.body.payment.hubOrderNo, 990);
  assert.equal((await api('/v1/admin/licenses', { accountId: newer.accountId, plan: 'internal_perpetual' }, admin)).status, 201);
  const refundNewer = await api('/v1/admin/refunds', { orderId: newerOrder.body.orderId, reason: '新权益前退款' }, admin);
  hubRefundStatus.set(refundNewer.body.refund.refundNo, { status: 3, refunded_time: '2026-06-16 10:35:00' });
  const newerDone = await api('/v1/admin/refunds/query', { refundNo: refundNewer.body.refund.refundNo }, admin);
  assert.equal(newerDone.body.refund.manualRequired, 'newer_revision_exists');
  assert.equal(newerDone.body.refund.entitlementRestored, false);
  assert.equal((await api('/v1/entitlement', undefined, newer.token)).body.entitlement.plan, 'internal_perpetual');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(newerOrder.body.orderId).status, 'paid');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(newerPay.body.payment.hubOrderNo).status, 'refunded');
});
test('a refund intent survives a hub failure and replays under its original idempotency key', async () => {
  const { token } = await registerLogin('pay-j@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0013' }, token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  markHubPaid(pay.body.payment.hubOrderNo);
  await notifyPaid(pay.body.payment.hubOrderNo, 990);
  hubFailNext = 'create-refund';
  assert.equal((await api('/v1/admin/refunds', { orderId, reason: '崩溃重放' }, admin)).status, 503);
  const intent = db.prepare('SELECT * FROM order_refunds WHERE order_id = ? AND refund_no IS NULL').get(orderId);
  assert.ok(intent);
  await api('/v1/admin/refunds/query', { orderId }, admin);
  const rows = db.prepare('SELECT * FROM order_refunds WHERE order_id = ?').all(orderId);
  assert.equal(rows.length, 1); assert.ok(rows[0].refund_no);
  hubRefundStatus.set(rows[0].refund_no, { status: 3, refunded_time: '2026-06-16 10:25:00' });
  await api('/v1/admin/refunds/query', { orderId }, admin);
  const finalRow = db.prepare('SELECT * FROM order_refunds WHERE order_id = ?').get(orderId);
  assert.equal(finalRow.status, 'succeeded'); assert.equal(finalRow.entitlement_restored, 1);
  const refundCalls = hubCalls.filter(call => call.path === `/v1/payments/orders/${pay.body.payment.hubOrderNo}/refunds`);
  assert.equal(refundCalls.length, 2);
  assert.equal(refundCalls[0].headers['idempotency-key'], refundCalls[1].headers['idempotency-key']);
});
test('concurrent /pay on one order yields a single hub attempt row', async () => {
  const { token } = await registerLogin('pay-l@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0014' }, token);
  const orderId = created.body.orderId;
  const attempts = await Promise.all([api(`/v1/orders/${orderId}/pay`, {}, token), api(`/v1/orders/${orderId}/pay`, {}, token)]);
  assert.deepEqual(attempts.map(item => item.status), [200, 200]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_payments WHERE order_id = ?').get(orderId).n, 1);
});
test('user-initiated close cancels a pending order; later payment lands as an incident', async () => {
  const { token, accountId } = await registerLogin('pay-o@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0017' }, token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const hubOrderNo = pay.body.payment.hubOrderNo;
  assert.equal((await api(`/v1/orders/${orderId}/close`, {}, token)).status, 200);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'closed');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo).status, 'closed');
  assert.equal((await api(`/v1/orders/${orderId}/pay`, {}, token)).status, 409);
  assert.equal((await api(`/v1/orders/${orderId}/close`, {}, token)).status, 409);
  markHubPaid(hubOrderNo);
  await notifyPaid(hubOrderNo, 990);
  assert.equal(db.prepare('SELECT count(*) AS n FROM licenses WHERE account_id = ?').get(accountId).n, 0);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'paid_after_closed_order'").get(hubOrderNo));
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo).status, 'paid');
});
test('creating a new order auto-closes previous pending orders (one pending per account)', async () => {
  const { token, accountId } = await registerLogin('pay-replace@example.com');
  const first = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'replace-key-0001' }, token);
  assert.equal(first.status, 201);
  const firstOrderId = first.body.orderId;
  await api(`/v1/orders/${firstOrderId}/pay`, {}, token);
  const second = await api('/v1/orders', { plan: 'annual', idempotencyKey: 'replace-key-0002' }, token);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.orderId, firstOrderId);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(firstOrderId).status, 'closed');
  const pending = db.prepare("SELECT count(*) AS n FROM orders WHERE account_id = ? AND status = 'pending_payment'").get(accountId).n;
  assert.equal(pending, 1);
  // 同键幂等重放不会误关本次要支付的订单
  const replay = await api('/v1/orders', { plan: 'annual', idempotencyKey: 'replace-key-0002' }, token);
  assert.equal(replay.body.orderId, second.body.orderId);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(second.body.orderId).status, 'pending_payment');
});
test('without payment configuration the service keeps working and pay answers payment_unavailable', async () => {
  const port = await freePort();
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-no-payment.sqlite'), ADMIN_TOKEN: admin, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    await fetch(`${alt}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pay-k@example.com', password: 'test-password-12345' }) });
    const login = await fetch(`${alt}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pay-k@example.com', password: 'test-password-12345' }) });
    const { sessionToken } = await login.json();
    const order = await fetch(`${alt}/v1/orders`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'monthly', idempotencyKey: 'no-payment-key-1' }) });
    const orderId = (await order.json()).orderId;
    assert.equal(order.status, 201);
    const pay = await fetch(`${alt}/v1/orders/${orderId}/pay`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(pay.status, 503);
    assert.deepEqual(await pay.json(), { code: 'payment_unavailable' });
    const notify = await fetch(`${alt}/v1/payments/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(notify.status, 503);
  } finally { isolated.kill(); await whenExited(isolated); }
});
test('an invalid hub client id fails startup closed', async () => {
  const port = await freePort();
  const invalid = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-bad-payment.sqlite'), ADMIN_TOKEN: admin, NODE_ENV: 'test', PAYMENT_HUB_BASE_URL: 'http://127.0.0.1:9', PAYMENT_HUB_CLIENT_ID: 'not-hex', PAYMENT_HUB_CLIENT_SECRET: 'secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  invalid.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await once(invalid, 'exit');
  assert.match(stderr, /PAYMENT_HUB_CLIENT_ID/u);
});
test('a hub-side refund of a settled order is observed on the next poll and keeps the money visible', async () => {
  const { token } = await registerLogin('pay-m@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0015' }, token);
  const orderId = created.body.orderId;
  const pay = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const hubOrderNo = pay.body.payment.hubOrderNo;
  markHubPaid(hubOrderNo);
  await notifyPaid(hubOrderNo, 990);
  const detailCalls = () => hubCalls.filter(call => call.method === 'GET' && call.path === `/v1/payments/orders/${hubOrderNo}`).length;
  await new Promise(resolve => setTimeout(resolve, 5100)); // clear the per-order hub query throttle
  hubOverrides.set(hubOrderNo, { status: 6, refunded_amount_cents: 990 });
  const view = await api(`/v1/orders/${orderId}`, undefined, token);
  assert.equal(view.body.order.status, 'paid'); // rights and order status stay for manual adjudication
  assert.equal(view.body.payment.status, 'refunded');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(hubOrderNo).status, 'refunded');
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'external_refund_observed'").get(hubOrderNo));
  const before = detailCalls();
  await new Promise(resolve => setTimeout(resolve, 5100));
  await api(`/v1/orders/${orderId}`, undefined, token);
  assert.equal(detailCalls(), before); // a refunded row leaves the poll loop; no re-trigger
  const refused = await api('/v1/admin/refunds', { orderId, hubOrderNo, reason: '误操作退款' }, admin);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'already_refunded');
});
test('an admin refund settles a lost-notify duplicate attempt before refunding it', async () => {
  const { token } = await registerLogin('pay-n@example.com');
  const created = await api('/v1/orders', { plan: 'monthly', idempotencyKey: 'pay-flow-key-0016' }, token);
  const orderId = created.body.orderId;
  const first = await api(`/v1/orders/${orderId}/pay`, {}, token);
  hubFailNext = 'prepay-cannot'; // force a second attempt whose payment notify is then lost
  const second = await api(`/v1/orders/${orderId}/pay`, {}, token);
  const secondNo = second.body.payment.hubOrderNo;
  markHubPaid(first.body.payment.hubOrderNo);
  await notifyPaid(first.body.payment.hubOrderNo, 990); // first attempt settles; the second attempt's notify never arrives
  markHubPaid(secondNo); // money arrived at the hub; the local row stays pending
  const refund = await api('/v1/admin/refunds', { orderId, hubOrderNo: secondNo, reason: '重复支付退款' }, admin);
  assert.equal(refund.status, 201);
  assert.ok(db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'duplicate_payment'").get(secondNo));
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(secondNo).status, 'paid');
  hubRefundStatus.set(refund.body.refund.refundNo, { status: 3, refunded_time: '2026-06-16 10:40:00' });
  const done = await api('/v1/admin/refunds/query', { refundNo: refund.body.refund.refundNo }, admin);
  assert.equal(done.body.refund.status, 'succeeded');
  assert.equal(done.body.refund.manualRequired, 'duplicate_attempt_refunded');
  assert.equal(db.prepare('SELECT status FROM order_payments WHERE hub_order_no = ?').get(secondNo).status, 'refunded');
});
