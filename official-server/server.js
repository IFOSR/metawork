import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { prompts } from './prompts.js';
import { settlementExpiry, refundRestoreRevision, yuanToCents, parseHubDatetime } from './business.js';
import { createHubClient, HubError } from './hub-payments.js';

process.umask(0o077);
const env = loadEnv();
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new Error('A strong ADMIN_TOKEN is required');
if (env.MODEL_BASE_URL) {
  const url = new URL(env.MODEL_BASE_URL);
  if (url.protocol !== 'https:' && !(env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Model endpoint must use HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid model endpoint');
}
const paymentEnv = {
  baseUrl: env.PAYMENT_HUB_BASE_URL || '',
  clientId: env.PAYMENT_HUB_CLIENT_ID || '',
  clientSecret: env.PAYMENT_HUB_CLIENT_SECRET || '',
  notifyUrl: env.PAYMENT_NOTIFY_URL || '',
  channel: env.PAYMENT_CHANNEL || 'wechat_native',
};
const paymentConfigured = Boolean(paymentEnv.baseUrl && paymentEnv.clientId && paymentEnv.clientSecret);
if (paymentEnv.baseUrl || paymentEnv.clientId || paymentEnv.clientSecret || paymentEnv.notifyUrl || env.PAYMENT_CHANNEL) {
  if (!paymentConfigured) throw new Error('PAYMENT_HUB_BASE_URL, PAYMENT_HUB_CLIENT_ID and PAYMENT_HUB_CLIENT_SECRET must be configured together');
  if (paymentEnv.channel !== 'wechat_native') throw new Error('Only the wechat_native payment channel is supported');
  const url = new URL(paymentEnv.baseUrl);
  if (url.protocol !== 'https:' && !(env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Payment hub endpoint must use HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid payment hub endpoint');
  if (!/^[0-9a-f]{32}$/u.test(paymentEnv.clientId)) throw new Error('PAYMENT_HUB_CLIENT_ID must be 32 lowercase hex characters');
  if (paymentEnv.notifyUrl) {
    if (!paymentEnv.notifyUrl.startsWith('https://') && !(env.NODE_ENV === 'test' && paymentEnv.notifyUrl.startsWith('http://127.0.0.1'))) throw new Error('Payment notify URL must use HTTPS');
    const notify = new URL(paymentEnv.notifyUrl);
    if (notify.search || notify.hash || notify.username || notify.password) throw new Error('Invalid payment notify URL');
  }
}
// With payments disabled the service keeps its pre-payment behavior; pay/refund entry points answer payment_unavailable.
const hub = paymentConfigured ? createHubClient({
  baseUrl: paymentEnv.baseUrl, clientId: paymentEnv.clientId, clientSecret: paymentEnv.clientSecret,
  notifyUrl: paymentEnv.notifyUrl || undefined,
  onClockSkew: () => console.error('payment_hub_clock_skew_suspected', JSON.stringify({})),
}) : null;
const databasePath = resolve(env.DATABASE_PATH ?? './data/official.sqlite');
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), token_digest TEXT NOT NULL UNIQUE, instance_id TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS licenses (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), plan TEXT NOT NULL, status TEXT NOT NULL, effective_at TEXT, expires_at TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), plan TEXT NOT NULL, amount_cny TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_usage (request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_payments (
    hub_order_no TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    code_url TEXT,
    expire_at TEXT,
    channel_order_no TEXT,
    channel_paid_amount_cents INTEGER,
    paid_at TEXT,
    settled_at TEXT,
    granted_license_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS order_payments_order ON order_payments(order_id, attempt);
  CREATE TABLE IF NOT EXISTS order_refunds (
    id TEXT PRIMARY KEY,
    refund_no TEXT UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    order_id TEXT NOT NULL REFERENCES orders(id),
    hub_order_no TEXT NOT NULL REFERENCES order_payments(hub_order_no),
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    entitlement_restored INTEGER NOT NULL DEFAULT 0,
    manual_required TEXT,
    channel_refund_no TEXT,
    refunded_time TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS order_refunds_order ON order_refunds(order_id);
  CREATE TABLE IF NOT EXISTS payment_incidents (
    incident_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    hub_order_no TEXT,
    order_id TEXT,
    detail TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS incident_open_unique ON payment_incidents(kind, hub_order_no) WHERE resolved = 0;
  CREATE INDEX IF NOT EXISTS incident_open_list ON payment_incidents(resolved, created_at);
`);
const rates = new Map();
const hubQueryAt = new Map();
let activePasswords = 0;
const derive = promisify(scrypt);
const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
  try { await route(request, response); }
  catch (error) {
    if (error instanceof SafeError) return send(response, error.status, { code: error.code });
    if (error instanceof HubError) {
      const [status, code] = presentHubError(error);
      return send(response, status, { code });
    }
    send(response, 500, { code: 'internal_error' });
  }
});
server.listen(Number(env.PORT ?? 8780), env.HOST ?? '127.0.0.1', () => console.log('MetaWork official service ready'));
const retention = setInterval(() => {
  db.prepare("DELETE FROM ai_usage WHERE created_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  db.prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  for (const [key, value] of rates) if (value.until < Date.now()) rates.delete(key);
  if (hubQueryAt.size > 10000) hubQueryAt.clear();
}, 60000);
retention.unref();
if (hub) { const refundSweep = setInterval(() => { void sweepRefunds(); }, 60000); refundSweep.unref(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(retention); server.close(() => { db.close(); process.exit(0); }); });

async function route(request, response) {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/healthz') return send(response, 200, { ok: true });
  if (path.startsWith('/v1/admin/')) return adminRoute(request, response, path);
  // Gateway notifications authenticate by HMAC signature, not by client IP, and must never feed the IP rate limiter.
  if (request.method === 'POST' && path === '/v1/payments/notify') return paymentNotify(request, response);
  const ip = request.socket.remoteAddress === '127.0.0.1' && env.TRUST_PROXY === '1'
    ? String(request.headers['x-real-ip'] ?? request.socket.remoteAddress) : request.socket.remoteAddress;
  if (path !== '/v1/ai/operation') rate(`http:${ip}`, Number(env.HTTP_RATE_MAX ?? 120), 60000);
  if (request.method === 'POST' && ['/v1/auth/login', '/v1/auth/register'].includes(path)) {
    rate(`auth:${ip}`, Number(env.AUTH_RATE_MAX ?? 10), 60000);
    const body = await readJson(request);
    const { email, password } = credentials(body);
    rate(`email:${email}`, Number(env.EMAIL_RATE_MAX ?? 10), 60000);
    if (activePasswords >= 4) fail(429, 'rate_limited');
    activePasswords++;
    try {
      if (path.endsWith('/register')) return send(response, 201, { account: await register(email, password) });
      const row = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
      const valid = await verifyPassword(password, row?.password_hash ?? dummyPassword);
      if (!row || row.disabled || !valid) fail(401, 'invalid_credentials');
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (id, account_id, token_digest, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id('ses'), row.id, digest(token), now(), now());
      return send(response, 200, { sessionToken: token, account: accountView(row), entitlement: entitlement(row.id) });
    } finally { activePasswords--; }
  }
  if (request.method === 'GET' && path === '/v1/plans') return send(response, 200, { plans: publicPlans() });
  const session = authenticate(request);
  if (!session) fail(401, 'session_invalid');
  if (request.method === 'POST' && path === '/v1/auth/logout') {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), session.id);
    return send(response, 204, null);
  }
  if (request.method === 'GET' && path === '/v1/auth/session') return send(response, 200, { account: accountView(session.account) });
  if (request.method === 'GET' && path === '/v1/entitlement') {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
    return send(response, 200, { entitlement: entitlement(session.account.id) });
  }
  if (request.method === 'POST' && path === '/v1/orders') {
    rate(`orders:${session.account.id}`, Number(env.ORDERS_RATE_MAX ?? 10), 60000);
    const body = await readJson(request);
    const selected = publicPlans().find(plan => plan.plan === body.plan);
    if (!selected) fail(400, 'invalid_plan');
    const key = `${session.account.id}:${requestId(body.idempotencyKey)}`;
    // 一个账号同时只允许一个待支付订单：新单创建前自动关闭旧单（含 Hub 侧二维码）。
    // 幂等重放（同键）不触发关闭，避免误关本次要支付的订单。
    if (selected.payment === 'pending_payment') {
      for (const stale of db.prepare("SELECT * FROM orders WHERE account_id = ? AND status = 'pending_payment' AND idempotency_key <> ? ORDER BY created_at").all(session.account.id, key)) {
        await closeOrder(stale);
      }
    }
    const result = transaction(() => {
      const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key);
      if (existing) { if (existing.plan !== body.plan) fail(409, 'idempotency_conflict'); return existing; }
      const current = entitlement(session.account.id);
      if (body.plan === 'trial') {
        if (db.prepare("SELECT id FROM licenses WHERE account_id = ? AND plan = 'trial'").get(session.account.id)) fail(409, 'trial_already_used');
        if (usable(current)) fail(409, 'active_plan_conflict');
      } else if (usable(current) && (current.plan === 'internal_perpetual' || !['trial', body.plan].includes(current.plan))) fail(409, 'active_plan_conflict');
      const order = { id: id('ord'), account_id: session.account.id, plan: body.plan, amount_cny: selected.amountCny, currency: 'CNY', status: body.plan === 'trial' ? 'confirmed' : 'pending_payment', idempotency_key: key, created_at: now() };
      db.prepare('INSERT INTO orders (id, account_id, plan, amount_cny, currency, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(order));
      if (body.plan === 'trial') grant(session.account.id, 'trial', new Date(Date.now() + 7 * 86400000).toISOString());
      return order;
    });
    return send(response, 201, orderView(result));
  }
  const payMatch = /^\/v1\/orders\/([A-Za-z0-9_-]+)\/pay$/u.exec(path);
  if (request.method === 'POST' && payMatch) return payOrder(response, session, payMatch[1]);
  const orderCloseMatch = /^\/v1\/orders\/([A-Za-z0-9_-]+)\/close$/u.exec(path);
  if (request.method === 'POST' && orderCloseMatch) return closeOwnOrder(response, session, orderCloseMatch[1]);
  const orderDetailMatch = /^\/v1\/orders\/([A-Za-z0-9_-]+)$/u.exec(path);
  if (request.method === 'GET' && orderDetailMatch) return orderDetailView(response, session, orderDetailMatch[1]);
  if (request.method === 'GET' && path === '/v1/orders') return orderListView(response, session);
  if (request.method === 'POST' && path === '/v1/ai/operation') return aiOperation(request, response, session);
  fail(404, 'not_found');
}

async function aiOperation(request, response, session) {
  assertEntitlement(request, session);
  const { operation, input } = await readJson(request, Infinity);
  if (typeof operation !== 'string' || !Object.hasOwn(prompts, operation)) fail(400, 'invalid_operation');
  if (input === undefined) fail(400, 'invalid_input');
  // Usage is an audit fact, not a quota or deduplication gate.
  db.prepare('INSERT INTO ai_usage (request_id, account_id, operation, created_at) VALUES (?, ?, ?, ?)')
    .run(id('ai'), session.account.id, operation, now());
  const result = await callModel(operation, input);
  assertEntitlement(request, session);
  return send(response, 200, { operation, result, entitlement: entitlement(session.account.id) });
}

async function callModel(operation, input) {
  const started = Date.now();
  let stage = 'configuration';
  let upstreamStatus;
  try {
    if (!env.MODEL_BASE_URL || !env.MODEL_API_KEY || !env.MODEL_ID) throw new Error();
    stage = 'upstream_request';
    const upstream = await fetch(`${env.MODEL_BASE_URL.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.MODEL_ID,
        messages: [{ role: 'system', content: prompts[operation] }, { role: 'user', content: JSON.stringify(input) }] }),
    });
    upstreamStatus = upstream.status;
    stage = 'upstream_status';
    if (!upstream.ok) throw new Error();
    stage = 'upstream_response';
    const value = await upstream.json();
    // Return only the business JSON. Rendering/activation owns its required fields.
    const content = value?.choices?.[0]?.message?.content;
    stage = 'output_json';
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1'));
  } catch {
    console.error('official_ai_failed', JSON.stringify({ operation, stage, upstreamStatus, durationMs: Date.now() - started }));
    fail(503, 'official_ai_unavailable');
  }
}

async function adminRoute(request, response, path) {
  // Nginx also blocks /v1/admin; administration is available only via SSH loopback.
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers['x-forwarded-for']) fail(403, 'admin_unauthorized');
  if (!timingSafeEqual(Buffer.from(digest(request.headers.authorization ?? '')), Buffer.from(digest(`Bearer ${env.ADMIN_TOKEN}`)))) fail(401, 'admin_unauthorized');
  if (request.method !== 'POST') fail(405, 'method_not_allowed');
  const body = await readJson(request);
  if (['/v1/admin/refunds', '/v1/admin/refunds/query', '/v1/admin/refunds/cancel', '/v1/admin/orders/close'].includes(path) && !hub) fail(503, 'payment_unavailable');
  if (path === '/v1/admin/accounts') {
    const { email, password } = credentials(body);
    return send(response, 201, { account: await register(email, password) });
  }
  if (path === '/v1/admin/refunds') {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 200) fail(400, 'invalid_reason');
    return send(response, 201, { refund: await initiateRefund(body.orderId, body.hubOrderNo, reason) });
  }
  if (path === '/v1/admin/refunds/query') {
    if (body.refundNo) return send(response, 200, { refund: await reconcileRefund(String(body.refundNo)) });
    if (body.orderId) return send(response, 200, { refunds: await reconcileOrderRefunds(String(body.orderId)) });
    fail(400, 'invalid_request');
  }
  if (path === '/v1/admin/refunds/cancel') {
    const refund = db.prepare('SELECT * FROM order_refunds WHERE refund_no = ?').get(String(body.refundNo ?? ''));
    if (!refund) fail(404, 'refund_not_found');
    if (refund.status !== 'created' || !refund.refund_no) fail(409, 'refund_not_cancellable');
    await hub.cancelHubRefund(refund.refund_no, `cancel-${refund.refund_no}`);
    db.prepare("UPDATE order_refunds SET status='closed', updated_at=? WHERE id=?").run(now(), refund.id);
    return send(response, 200, { cancelled: true });
  }
  if (path === '/v1/admin/orders') {
    const account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(body.email ?? '').trim().toLowerCase());
    if (!account) fail(404, 'account_not_found');
    const orders = db.prepare('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(account.id).map(order => ({
      ...orderView(order),
      payments: db.prepare('SELECT hub_order_no, attempt, status, amount_cents, paid_at, granted_license_id FROM order_payments WHERE order_id = ? ORDER BY attempt').all(order.id),
      refunds: db.prepare('SELECT refund_no, hub_order_no, amount_cents, status, manual_required FROM order_refunds WHERE order_id = ? ORDER BY created_at').all(order.id),
    }));
    return send(response, 200, { account: accountView(account), entitlement: entitlement(account.id), orders });
  }
  if (path === '/v1/admin/orders/close') {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(body.orderId ?? ''));
    if (!order) fail(404, 'order_not_found');
    if (order.status !== 'pending_payment') fail(409, 'order_not_closeable');
    await closeOrder(order);
    return send(response, 200, { closed: true });
  }
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(body.accountId ?? ''));
  if (!account) fail(404, 'account_not_found');
  if (path === '/v1/admin/licenses') {
    if (body.plan !== 'internal_perpetual') fail(400, 'invalid_plan');
    transaction(() => { if (entitlement(account.id).plan !== 'internal_perpetual' || !usable(entitlement(account.id))) grant(account.id, 'internal_perpetual', null); });
    return send(response, 201, { entitlement: entitlement(account.id) });
  }
  if (path === '/v1/admin/revoke') {
    transaction(() => {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL').run(now(), account.id);
      const current = entitlement(account.id);
      if (current.plan) grant(account.id, current.plan, current.expiresAt, 'revoked');
      if (body.disable === true) db.prepare('UPDATE accounts SET disabled = 1 WHERE id = ?').run(account.id);
    });
    return send(response, 200, { revoked: true });
  }
  fail(404, 'not_found');
}

async function payOrder(response, session, orderId) {
  rate(`pay:${session.account.id}`, Number(env.PAY_RATE_MAX ?? 10), 60000);
  if (!hub) fail(503, 'payment_unavailable');
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, session.account.id);
  if (!order) fail(404, 'order_not_found');
  if (order.status !== 'pending_payment' || !['monthly', 'annual'].includes(order.plan)) fail(409, 'order_not_payable');
  await openPaymentAttempt(order);
  const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const row = db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY attempt DESC LIMIT 1').get(orderId);
  return send(response, 200, { order: orderView(fresh), payment: paymentView(row) });
}

// 用户取消自己的待支付订单；若关单与支付竞态（钱已到账），按关闭后到账政策落 incident 人工退款。
async function closeOwnOrder(response, session, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, session.account.id);
  if (!order) fail(404, 'order_not_found');
  if (order.status !== 'pending_payment') fail(409, 'order_not_closeable');
  await closeOrder(order);
  const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const row = db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY attempt DESC LIMIT 1').get(orderId);
  return send(response, 200, { order: orderView(fresh), payment: paymentView(row) });
}

// Shared by the admin route and the session route; runs after the caller's own transaction.
async function closeOrder(order) {
  transaction(() => { db.prepare("UPDATE orders SET status='closed' WHERE id=?").run(order.id); });
  if (hub) for (const row of db.prepare("SELECT * FROM order_payments WHERE order_id = ? AND status = 'pending'").all(order.id)) {
    await closePaymentAttempt(row);
  }
}

async function openPaymentAttempt(order) {
  const existing = db.prepare("SELECT * FROM order_payments WHERE order_id = ? AND status = 'pending' ORDER BY attempt DESC LIMIT 1").get(order.id);
  if (existing) {
    try {
      const hubOrder = await hub.prepayHubOrder(existing.hub_order_no, `prepay-${existing.hub_order_no}`);
      db.prepare('UPDATE order_payments SET code_url=coalesce(?, code_url), expire_at=coalesce(?, expire_at), updated_at=? WHERE hub_order_no=?')
        .run(hubOrder.qr_code_url ?? null, parseHubDatetime(hubOrder.expire_time), now(), existing.hub_order_no);
      return;
    } catch (error) {
      if (!(error instanceof HubError) || !['OPC_PAY_ORDER_CANNOT_PREPAY', 'OPC_PAY_ORDER_EXPIRED'].includes(error.code)) throw error;
    }
    await closePaymentAttempt(existing);
    // Closing can race a payment; settlement decides, and a settled order must not open another attempt.
    if (db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status !== 'pending_payment') return;
  }
  const next = db.prepare('SELECT coalesce(max(attempt), 0) + 1 AS n FROM order_payments WHERE order_id = ?').get(order.id).n;
  const idempotencyKey = `pay-${order.id}${next > 1 ? `-a${next}` : ''}`;
  const hubOrder = await hub.createHubOrder({
    amountCents: yuanToCents(order.amount_cny),
    description: `MetaWork ${order.plan === 'annual' ? '年度' : '月度'}订阅`,
    notifyUrl: paymentEnv.notifyUrl || undefined,
    expireMinutes: 30,
    idempotencyKey,
  });
  const stamp = now();
  db.prepare("INSERT INTO order_payments (hub_order_no, order_id, attempt, status, amount_cents, currency, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, 'CNY', ?, ?) ON CONFLICT(hub_order_no) DO NOTHING")
    .run(hubOrder.order_no, order.id, next, yuanToCents(order.amount_cny), stamp, stamp);
  const prepay = await hub.prepayHubOrder(hubOrder.order_no, `prepay-${hubOrder.order_no}`);
  db.prepare('UPDATE order_payments SET code_url=?, expire_at=?, updated_at=? WHERE hub_order_no=?')
    .run(prepay.qr_code_url ?? null, parseHubDatetime(prepay.expire_time), now(), hubOrder.order_no);
}

async function closePaymentAttempt(row) {
  try {
    await hub.closeHubOrder(row.hub_order_no, `close-${row.hub_order_no}`);
    db.prepare("UPDATE order_payments SET status='closed', updated_at=? WHERE hub_order_no=? AND status='pending'").run(now(), row.hub_order_no);
  } catch (error) {
    if (error instanceof HubError && ['OPC_PAY_ORDER_CANNOT_CLOSE', 'OPC_PAY_ORDER_ALREADY_PAID'].includes(error.code)) {
      const hubOrder = await hub.queryHubOrder(row.hub_order_no);
      if (String(hubOrder.status) === '3') { settlePayment(row, normalizeHubOrder(hubOrder)); return; }
    }
    // Best effort: transient hub failures leave the row pending; notify or a later pay reconciles it.
  }
}

async function orderDetailView(response, session, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, session.account.id);
  if (!order) fail(404, 'order_not_found');
  if (hub) {
    // Reconcile every live attempt row: pending rows settle or close, and paid rows must still catch hub-side
    // refunds — the hub sends no refund callback, so polling and admin routes are the only detection paths.
    for (const row of db.prepare("SELECT * FROM order_payments WHERE order_id = ? AND status IN ('pending', 'paid') ORDER BY attempt").all(orderId)) {
      if (!hubQueryAllowed(row.hub_order_no)) continue;
      try {
        const hubOrder = await hub.queryHubOrder(row.hub_order_no);
        const hubStatus = String(hubOrder.status);
        if (hubStatus === '3' && row.status === 'pending') settlePayment(row, normalizeHubOrder(hubOrder));
        else if (['4', '5'].includes(hubStatus) && row.status === 'pending') db.prepare("UPDATE order_payments SET status='closed', updated_at=? WHERE hub_order_no=? AND status='pending'").run(now(), row.hub_order_no);
        else if (['6', '7'].includes(hubStatus)) transaction(() => {
          db.prepare("UPDATE order_payments SET status='refunded', updated_at=? WHERE hub_order_no=? AND status IN ('pending', 'paid')").run(now(), row.hub_order_no);
          recordIncident('external_refund_observed', row.hub_order_no, order.id);
        });
      } catch { /* reconciliation is best effort; the local view is still served */ }
    }
  }
  const freshOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const freshRow = db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY attempt DESC LIMIT 1').get(orderId);
  return send(response, 200, { order: orderView(freshOrder), payment: paymentView(freshRow) });
}

function orderListView(response, session) {
  const orders = db.prepare('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(session.account.id)
    .map(order => ({ ...orderView(order), payment: paymentView(db.prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY attempt DESC LIMIT 1').get(order.id)) }));
  return send(response, 200, { orders });
}

async function paymentNotify(request, response) {
  if (!hub) fail(503, 'payment_unavailable');
  const raw = await boundedText(request, 64 * 1024);
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  // The notification binds to this client through its signature; client-id equality is a soft operational signal only.
  if (!hub.verifyNotify({ rawBody: raw, headers: request.headers, path: pathname })) fail(401, 'invalid_signature');
  if (request.headers['x-client-id'] !== paymentEnv.clientId) console.warn('payment_notify_client_id_mismatch', JSON.stringify({}));
  let event = null;
  try { event = JSON.parse(raw); } catch { fail(400, 'invalid_json'); }
  if (!event || event.event_type !== 'PAYMENT.PAID' || typeof event.order_no !== 'string') {
    console.error('payment_notify_ignored', JSON.stringify({ reason: 'unexpected_event' }));
    return send(response, 200, { received: true });
  }
  const row = db.prepare('SELECT * FROM order_payments WHERE hub_order_no = ?').get(event.order_no);
  if (!row) {
    // Real money can only arrive for QR codes this service prepayed; an unknown order means lost local state or forgery and must stay visible.
    transaction(() => { recordIncident('unknown_order', event.order_no, null); });
    return send(response, 200, { received: true });
  }
  settlePayment(row, { amountCents: event.amount_cents, paidAt: epochToIso(event.paid_time_epoch) });
  void backfillChannelFacts(event.order_no);
  return send(response, 200, { received: true });
}

async function backfillChannelFacts(hubOrderNo) {
  try {
    const hubOrder = await hub.queryHubOrder(hubOrderNo);
    db.prepare('UPDATE order_payments SET channel_order_no=coalesce(channel_order_no, ?), channel_paid_amount_cents=coalesce(channel_paid_amount_cents, ?), updated_at=? WHERE hub_order_no=?')
      .run(hubOrder.channel_order_no ?? null, typeof hubOrder.channel_paid_amount === 'number' ? hubOrder.channel_paid_amount : null, now(), hubOrderNo);
  } catch { /* enrichment only */ }
}

// Runs entirely inside one immediate transaction: local reads and writes only, never a hub call.
function settlePayment(row, hubFacts) {
  return transaction(() => {
    const fresh = db.prepare('SELECT * FROM order_payments WHERE hub_order_no = ?').get(row.hub_order_no);
    if (!fresh || fresh.settled_at) return false;
    const order = db.prepare('SELECT o.*, a.disabled FROM orders o JOIN accounts a ON a.id = o.account_id WHERE o.id = ?').get(fresh.order_id);
    if (!order) return false;
    const markPaid = () => {
      db.prepare("UPDATE order_payments SET status='paid', paid_at=coalesce(?, paid_at), settled_at=?, channel_order_no=coalesce(?, channel_order_no), channel_paid_amount_cents=coalesce(?, channel_paid_amount_cents), updated_at=? WHERE hub_order_no=?")
        .run(hubFacts.paidAt ?? null, now(), hubFacts.channelOrderNo ?? null, hubFacts.channelPaidAmountCents ?? null, now(), fresh.hub_order_no);
    };
    const refuse = kind => { markPaid(); recordIncident(kind, fresh.hub_order_no, fresh.order_id); return false; };
    if (order.status === 'paid') return refuse('duplicate_payment');
    if (order.status !== 'pending_payment') return refuse('paid_after_closed_order');
    if (hubFacts.amountCents !== yuanToCents(order.amount_cny)) return refuse('amount_mismatch');
    if (order.disabled) return refuse('disabled_account_paid');
    const current = entitlement(order.account_id);
    if (usable(current) && current.plan === 'internal_perpetual') return refuse('perpetual_conflict');
    const expiresAt = settlementExpiry({ plan: order.plan, paidAt: hubFacts.paidAt ?? now(), currentEntitlement: current });
    const licenseId = grant(order.account_id, order.plan, expiresAt);
    db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
    markPaid();
    db.prepare('UPDATE order_payments SET granted_license_id=?, updated_at=? WHERE hub_order_no=?').run(licenseId, now(), fresh.hub_order_no);
    return true;
  });
}

function normalizeHubOrder(hubOrder) {
  return {
    amountCents: hubOrder.amount_cents,
    paidAt: parseHubDatetime(hubOrder.paid_time) ?? now(),
    channelOrderNo: hubOrder.channel_order_no ?? null,
    channelPaidAmountCents: typeof hubOrder.channel_paid_amount === 'number' ? hubOrder.channel_paid_amount : null,
  };
}

async function initiateRefund(orderId, hubOrderNo, reason) {
  if (!hub) fail(503, 'payment_unavailable');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId ?? ''));
  if (!order) fail(404, 'order_not_found');
  const row = hubOrderNo
    ? db.prepare('SELECT * FROM order_payments WHERE order_id = ? AND hub_order_no = ?').get(orderId, String(hubOrderNo))
    : db.prepare('SELECT * FROM order_payments WHERE order_id = ? AND granted_license_id IS NOT NULL ORDER BY attempt DESC LIMIT 1').get(orderId);
  if (!row) fail(404, 'payment_attempt_not_found');
  const inflight = db.prepare("SELECT id FROM order_refunds WHERE order_id = ? AND hub_order_no = ? AND status IN ('created', 'processing')").get(orderId, row.hub_order_no);
  if (inflight) fail(409, 'refund_in_progress');
  // Reconcile before the paid guard: hub-side money facts outrank the local row. A lost notify leaves the row
  // pending while the money arrived; settlement self-guards (idempotent return, or a duplicate/incident branch
  // that marks the row paid and keeps it refundable).
  const hubOrder = await hub.queryHubOrder(row.hub_order_no);
  if (String(hubOrder.status) === '3') settlePayment(row, normalizeHubOrder(hubOrder));
  if (['6', '7'].includes(String(hubOrder.status))) {
    transaction(() => {
      db.prepare("UPDATE order_payments SET status='refunded', updated_at=? WHERE hub_order_no=? AND status IN ('pending', 'paid')").run(now(), row.hub_order_no);
      recordIncident('external_refund_observed', row.hub_order_no, order.id);
    });
    fail(409, 'already_refunded');
  }
  const fresh = db.prepare('SELECT * FROM order_payments WHERE hub_order_no = ?').get(row.hub_order_no);
  if (fresh.status !== 'paid') fail(409, fresh.status === 'refunded' ? 'already_refunded' : 'attempt_not_paid');
  const refundable = (typeof hubOrder.channel_paid_amount === 'number' ? hubOrder.channel_paid_amount : hubOrder.amount_cents) - (hubOrder.refunded_amount_cents ?? 0);
  if (refundable <= 0) fail(409, 'nothing_to_refund');
  const sequence = db.prepare('SELECT count(*) AS n FROM order_refunds WHERE order_id = ? AND hub_order_no = ?').get(orderId, row.hub_order_no).n + 1;
  const idempotencyKey = `refund-${orderId}-${fresh.attempt}${sequence > 1 ? `-r${sequence}` : ''}`;
  const refundId = id('rfd');
  db.prepare("INSERT INTO order_refunds (id, refund_no, idempotency_key, order_id, hub_order_no, amount_cents, currency, reason, status, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'created', ?, ?)")
    .run(refundId, idempotencyKey, orderId, row.hub_order_no, refundable, 'CNY', reason, now(), now());
  const refund = await hub.createHubRefund(row.hub_order_no, { amountCents: refundable, reason }, idempotencyKey);
  db.prepare('UPDATE order_refunds SET refund_no=?, status=?, updated_at=? WHERE id=?').run(refund.refund_no, mapRefundStatus(refund.status), now(), refundId);
  try {
    await hub.processHubRefund(refund.refund_no, `process-${refund.refund_no}`);
    db.prepare("UPDATE order_refunds SET status='processing', updated_at=? WHERE id=?").run(now(), refundId);
  } catch { /* left in created; the sweep or an admin query re-processes it */ }
  return refundRowView(db.prepare('SELECT * FROM order_refunds WHERE id = ?').get(refundId));
}

async function reconcileRefund(refundNo) {
  if (!hub) fail(503, 'payment_unavailable');
  const refund = db.prepare('SELECT * FROM order_refunds WHERE refund_no = ?').get(refundNo);
  if (!refund) fail(404, 'refund_not_found');
  const hubRefund = await hub.queryHubRefund(refundNo);
  const status = mapRefundStatus(hubRefund.status);
  transaction(() => {
    // 权益恢复/人工标记只在首次进入终态时应用一次；重复对账（sweep + 手动查询）不得重复应用。
    const previousStatus = refund.status;
    db.prepare('UPDATE order_refunds SET status=?, channel_refund_no=coalesce(?, channel_refund_no), refunded_time=coalesce(?, refunded_time), updated_at=? WHERE id=?')
      .run(status, hubRefund.channel_refund_no ?? null, hubRefund.refunded_time ?? null, now(), refund.id);
    if (status === 'succeeded' && previousStatus !== 'succeeded') applyRefundEntitlement(db.prepare('SELECT * FROM order_refunds WHERE id = ?').get(refund.id));
    else if (status === 'exception' && previousStatus !== 'exception') db.prepare("UPDATE order_refunds SET manual_required=coalesce(manual_required, 'hub_exception'), updated_at=? WHERE id=?").run(now(), refund.id);
  });
  return refundRowView(db.prepare('SELECT * FROM order_refunds WHERE id = ?').get(refund.id));
}

async function reconcileOrderRefunds(orderId) {
  if (!hub) fail(503, 'payment_unavailable');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(orderId ?? ''));
  if (!order) fail(404, 'order_not_found');
  // Crash-window replay: intents without a hub refund number are re-created under their original idempotency key.
  for (const intent of db.prepare('SELECT * FROM order_refunds WHERE order_id = ? AND refund_no IS NULL').all(order.id)) {
    const refund = await hub.createHubRefund(intent.hub_order_no, { amountCents: intent.amount_cents, reason: intent.reason }, intent.idempotency_key).catch(() => null);
    if (refund?.refund_no) db.prepare('UPDATE order_refunds SET refund_no=?, status=?, updated_at=? WHERE id=?').run(refund.refund_no, mapRefundStatus(refund.status), now(), intent.id);
  }
  const views = [];
  for (const refund of db.prepare("SELECT * FROM order_refunds WHERE order_id = ? AND refund_no IS NOT NULL AND status IN ('created', 'processing')").all(order.id)) {
    try {
      if (refund.status === 'created') {
        await hub.processHubRefund(refund.refund_no, `process-${refund.refund_no}`);
        db.prepare("UPDATE order_refunds SET status='processing', updated_at=? WHERE id=?").run(now(), refund.id);
      }
      views.push(await reconcileRefund(refund.refund_no));
    } catch { views.push(refundRowView(db.prepare('SELECT * FROM order_refunds WHERE id = ?').get(refund.id))); }
  }
  if (!views.length) for (const refund of db.prepare('SELECT * FROM order_refunds WHERE order_id = ?').all(order.id)) views.push(refundRowView(refund));
  return views;
}

// Ordered decision table; the first matching row wins and the predicates stay disjoint.
function applyRefundEntitlement(refund) {
  const payment = db.prepare('SELECT * FROM order_payments WHERE hub_order_no = ?').get(refund.hub_order_no);
  const order = payment ? db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id) : null;
  if (!payment || !order) return;
  db.prepare("UPDATE order_payments SET status='refunded', updated_at=? WHERE hub_order_no=?").run(now(), refund.hub_order_no);
  // Money went back to the customer: every open incident on this attempt is settled by definition.
  db.prepare('UPDATE payment_incidents SET resolved=1, updated_at=? WHERE hub_order_no=? AND resolved=0').run(now(), refund.hub_order_no);
  const anchorId = payment.granted_license_id;
  const latest = db.prepare('SELECT * FROM licenses WHERE account_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1').get(order.account_id);
  if (anchorId && latest && latest.id === anchorId) {
    const history = db.prepare('SELECT * FROM licenses WHERE account_id = ? ORDER BY revision').all(order.account_id);
    const restored = refundRestoreRevision(history, anchorId);
    if (restored) grant(order.account_id, restored.plan, restored.expiresAt, restored.status);
    db.prepare('UPDATE order_refunds SET entitlement_restored=1, updated_at=? WHERE id=?').run(now(), refund.id);
    db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(order.id);
    return;
  }
  if (anchorId) {
    db.prepare("UPDATE order_refunds SET manual_required=coalesce(manual_required, 'newer_revision_exists'), updated_at=? WHERE id=?").run(now(), refund.id);
    return;
  }
  const duplicate = db.prepare("SELECT incident_id FROM payment_incidents WHERE hub_order_no = ? AND kind = 'duplicate_payment'").get(refund.hub_order_no);
  if (duplicate) {
    db.prepare("UPDATE order_refunds SET manual_required=coalesce(manual_required, 'duplicate_attempt_refunded'), updated_at=? WHERE id=?").run(now(), refund.id);
    return;
  }
  // Incident-driven refund: no license was ever granted; a still-pending order is dead once the money went back.
  db.prepare("UPDATE orders SET status='closed' WHERE id=? AND status='pending_payment'").run(order.id);
}

async function sweepRefunds() {
  try {
    for (const intent of db.prepare('SELECT * FROM order_refunds WHERE refund_no IS NULL').all()) {
      const refund = await hub.createHubRefund(intent.hub_order_no, { amountCents: intent.amount_cents, reason: intent.reason }, intent.idempotency_key).catch(() => null);
      if (refund?.refund_no) db.prepare('UPDATE order_refunds SET refund_no=?, status=?, updated_at=? WHERE id=?').run(refund.refund_no, mapRefundStatus(refund.status), now(), intent.id);
    }
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    for (const refund of db.prepare("SELECT * FROM order_refunds WHERE refund_no IS NOT NULL AND status IN ('created', 'processing') AND created_at > ?").all(cutoff)) {
      if (refund.status === 'created') {
        try {
          await hub.processHubRefund(refund.refund_no, `process-${refund.refund_no}`);
          db.prepare("UPDATE order_refunds SET status='processing', updated_at=? WHERE id=?").run(now(), refund.id);
        } catch (error) {
          if (!(error instanceof HubError && error.code === 'OPC_STATE_IDEMPOTENCY_PROCESSING')) continue;
        }
      }
      await reconcileRefund(refund.refund_no).catch(() => {});
    }
  } catch { /* the sweep never throws into the process */ }
}

function mapRefundStatus(hubStatus) {
  return { 1: 'created', 2: 'processing', 3: 'succeeded', 4: 'failed', 5: 'closed', 6: 'exception' }[Number(hubStatus)] ?? 'processing';
}

// Client-facing surfaces see the documented payment_* contract (plan §4); other OPC_* codes pass through for admin surfaces.
function presentHubError(error) {
  if (error.status === 429 || error.code === 'OPC_STATE_IDEMPOTENCY_PROCESSING') return [429, 'payment_hub_busy'];
  if (error.code === 'payment_hub_unreachable') return [503, 'payment_hub_busy'];
  if (error.code === 'OPC_PAY_ORDER_EXPIRED') return [error.status, 'payment_order_expired'];
  if (['OPC_PAY_ORDER_ALREADY_PAID', 'OPC_PAY_ORDER_CANNOT_PREPAY'].includes(error.code)) return [error.status, 'payment_order_state_conflict'];
  return [error.status, error.code];
}

function refundRowView(row) {
  return {
    refundId: row.id, refundNo: row.refund_no, orderId: row.order_id, hubOrderNo: row.hub_order_no,
    amountCents: row.amount_cents, currency: row.currency, reason: row.reason, status: row.status,
    entitlementRestored: Boolean(row.entitlement_restored), manualRequired: row.manual_required ?? null,
    channelRefundNo: row.channel_refund_no ?? null, refundedTime: row.refunded_time ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function paymentView(row) {
  if (!row) return null;
  return {
    hubOrderNo: row.hub_order_no, attempt: row.attempt, status: row.status, amountCents: row.amount_cents,
    qrCodeUrl: row.code_url ?? null, expiresAt: row.expire_at ?? null, paidAt: row.paid_at ?? null,
    channelOrderNo: row.channel_order_no ?? null,
  };
}

function recordIncident(kind, hubOrderNo, orderId) {
  db.prepare('INSERT INTO payment_incidents (incident_id, kind, hub_order_no, order_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, hub_order_no) WHERE resolved = 0 DO NOTHING')
    .run(id('inc'), kind, hubOrderNo, orderId ?? null, now(), now());
}

function hubQueryAllowed(key) {
  if (hubQueryAt.size > 10000) hubQueryAt.clear();
  const last = hubQueryAt.get(key) ?? 0;
  if (Date.now() - last < 5000) return false;
  hubQueryAt.set(key, Date.now());
  return true;
}

function epochToIso(epoch) {
  const value = Number(epoch);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : now();
}

async function register(email, password) {
  if (db.prepare('SELECT id FROM accounts WHERE email = ?').get(email)) fail(409, 'account_exists');
  const row = { id: id('acct'), email, display_name: email.slice(0, 120) };
  const hash = await hashPassword(password);
  try { db.prepare('INSERT INTO accounts (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(row.id, row.email, row.display_name, hash, now()); }
  catch { fail(409, 'account_exists'); }
  return accountView(row);
}
function credentials(body) {
  if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.email)
    || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'invalid_account');
  return { email: body.email.trim().toLowerCase(), password: body.password };
}
function authenticate(request) {
  const token = request.headers.authorization;
  if (!token?.startsWith('Bearer ') || token.length > 256) return null;
  const row = db.prepare('SELECT s.*, a.email, a.display_name FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_digest = ? AND s.revoked_at IS NULL AND a.disabled = 0').get(digest(token.slice(7)));
  return row ? { id: row.id, account: { id: row.account_id, email: row.email, display_name: row.display_name } } : null;
}
function assertEntitlement(request, session) {
  if (!authenticate(request)) fail(401, 'session_invalid');
  if (!usable(entitlement(session.account.id))) fail(402, 'entitlement_inactive');
}
function grant(accountId, plan, expiresAt, status = 'active') {
  const revision = db.prepare('SELECT coalesce(max(revision), 0) + 1 AS n FROM licenses WHERE account_id = ?').get(accountId).n;
  const licenseId = id('lic');
  db.prepare('INSERT INTO licenses (id, account_id, plan, status, effective_at, expires_at, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(licenseId, accountId, plan, status, now(), expiresAt, revision, now());
  return licenseId;
}
function entitlement(accountId) {
  const row = db.prepare('SELECT * FROM licenses WHERE account_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1').get(accountId);
  const timestamp = now();
  if (!row) {
    const pending = db.prepare("SELECT id FROM orders WHERE account_id = ? AND status = 'pending_payment' LIMIT 1").get(accountId);
    return { status: pending ? 'pending_payment' : 'unknown', plan: null, effectiveAt: null, expiresAt: null, revision: 0, serverTime: timestamp };
  }
  let status = row.status;
  if (status === 'active' && row.expires_at && Date.parse(row.expires_at) <= Date.now()) status = 'expired';
  return { status: row.plan === 'trial' && status === 'active' ? 'trial' : status, plan: row.plan, effectiveAt: row.effective_at, expiresAt: row.expires_at, revision: row.revision, serverTime: timestamp };
}
function usable(value) { return ['active', 'trial'].includes(value.status) && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now()) && Date.parse(value.effectiveAt) <= Date.now(); }
function publicPlans() { return [{ plan: 'trial', amountCny: '0.00', currency: 'CNY', duration: '7 天', payment: 'activate' }, { plan: 'monthly', amountCny: '9.90', currency: 'CNY', duration: '自然月', payment: 'pending_payment' }, { plan: 'annual', amountCny: '99.00', currency: 'CNY', duration: '自然年', payment: 'pending_payment' }]; }
function accountView(row) { return { accountId: row.id, email: row.email, displayName: row.display_name }; }
function orderView(row) { return { orderId: row.id, plan: row.plan, amountCny: row.amount_cny, currency: row.currency, status: row.status, createdAt: row.created_at }; }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
class SafeError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function fail(status, code) { throw new SafeError(status, code); }
function send(response, status, body) { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body === null ? '' : `${JSON.stringify(body)}\n`); }
async function boundedText(stream, limit) { const chunks = []; let size = 0; for await (const chunk of stream) { size += chunk.length; if (size > limit) fail(413, 'request_too_large'); chunks.push(chunk); } return Buffer.concat(chunks).toString('utf8'); }
async function readJson(request, limit = 64 * 1024) { if (Number(request.headers['content-length'] ?? 0) > limit) fail(413, 'request_too_large'); if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'json_required'); const text = await boundedText(request, limit); let result; try { result = JSON.parse(text); } catch { fail(400, 'invalid_json'); } if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'invalid_json'); return result; }
function requestId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) fail(400, 'invalid_request_id'); return value; }
function rate(key, max, window) { const old = rates.get(key); const value = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + window }; if (++value.count > max) fail(429, 'rate_limited'); if (rates.size >= 20000 && !rates.has(key)) fail(429, 'rate_limited'); rates.set(key, value); }
function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomBytes(12).toString('hex')}`; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${(await derive(password, salt, 32)).toString('hex')}`; }
async function verifyPassword(password, encoded) { try { const [, salt, expected] = encoded.split(':'); return timingSafeEqual(await derive(password, salt, 32), Buffer.from(expected, 'hex')); } catch { return false; } }
function loadEnv() { const values = { ...process.env }; try { for (const line of readFileSync('.env', 'utf8').split(/\r?\n/u)) { const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/u); if (match && values[match[1]] === undefined) values[match[1]] = match[2].replace(/^['"]|['"]$/gu, ''); } } catch {} return values; }
