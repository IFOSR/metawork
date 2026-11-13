import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { prompts } from './prompts.js';
import { parseHubDatetime, refundRestoreRevision, settlementExpiry, yuanToCents } from './business.js';
import { createHubClient, HubError } from './hub-payments.js';
import { createMailer } from './mailer.js';

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
// 沙盒预配的 K8s API 地址仅测试可覆盖（本地桩）；生产固定走 in-cluster ServiceAccount。
if (env.K8S_API_BASE && env.NODE_ENV !== 'test') throw new Error('K8S_API_BASE is a test-only override');
// 免密门禁/会话兑换依赖 HMAC 密钥；沙盒镜像启用时必须配置强密钥。
if ((env.RUNTIME_IMAGE || '').trim() && (!env.RUNTIME_ACCESS_SECRET || env.RUNTIME_ACCESS_SECRET.length < 32)) {
  throw new Error('RUNTIME_ACCESS_SECRET (>=32 chars) is required when RUNTIME_IMAGE is configured');
}
// With payments disabled the service keeps its pre-payment behavior; pay/refund entry points answer payment_unavailable.
const hub = paymentConfigured ? createHubClient({
  baseUrl: paymentEnv.baseUrl, clientId: paymentEnv.clientId, clientSecret: paymentEnv.clientSecret,
  notifyUrl: paymentEnv.notifyUrl || undefined,
  onClockSkew: () => console.error('payment_hub_clock_skew_suspected', JSON.stringify({})),
}) : null;
// Registration delivers verification codes by mail; without SMTP config the register
// entry answers email_unavailable while login for existing accounts keeps working.
const smtpOutbox = env.NODE_ENV === 'test' ? [] : null;
const mailer = createMailer({
  host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
  user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM, outbox: smtpOutbox,
});
const databasePath = resolve(env.DATABASE_PATH ?? './data/official.sqlite');
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
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
  CREATE TABLE IF NOT EXISTS runtimes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    name TEXT,
    slug TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    domain TEXT NOT NULL,
    pod_phase TEXT,
    vpa_json TEXT,
    steps_json TEXT NOT NULL,
    last_access_at TEXT,
    suspend_at TEXT,
    access_generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  DROP INDEX IF EXISTS runtimes_account_active;
  CREATE UNIQUE INDEX IF NOT EXISTS runtimes_account_active ON runtimes(account_id) WHERE status IN ('provisioning', 'running', 'updating', 'suspended', 'recycle_pending');
  CREATE INDEX IF NOT EXISTS runtimes_account_list ON runtimes(account_id, created_at);
`);
// 存量库补列（新建表已含该列，重复执行按列已存在吞掉）。
try { db.exec("ALTER TABLE runtimes ADD COLUMN suspend_at TEXT"); } catch { /* 列已存在 */ }
try { db.exec("ALTER TABLE runtimes ADD COLUMN access_generation INTEGER NOT NULL DEFAULT 1"); } catch { /* 列已存在 */ }
// applied_image：实际运行的镜像引用（就绪后才写入）。image 只是期望值——点更新按钮
// 瞬间就变了，不代表容器已经在跑它。service_ready：服务真正可用的标志，前端
// 据此决定是否显示"进入实例"。
try { db.exec("ALTER TABLE runtimes ADD COLUMN applied_image TEXT"); } catch { /* 列已存在 */ }
try { db.exec("ALTER TABLE runtimes ADD COLUMN service_ready INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
const rates = new Map();
const hubQueryAt = new Map();
const emailCodes = new Map();
let activePasswords = 0;
const derive = promisify(scrypt);
const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
// 沙盒环境（托管 Runtime 实例）配置；文档 docs/plans/2026-11-09-official-runtime-provisioning-design.md。
const runtimeEnv = {
  baseDomain: env.RUNTIME_BASE_DOMAIN || 'metawork.nexusfusionai.com',
  namespace: env.RUNTIME_NAMESPACE || 'nexusfusionai',
  image: env.RUNTIME_IMAGE || '',
  port: Number(env.RUNTIME_PORT ?? 8788) || 8788,
  tlsSecret: env.RUNTIME_TLS_SECRET || 'metawork-nexusfusionai-com-tls',
  storageClass: env.RUNTIME_STORAGE_CLASS || 'cloud-nas-cnfs',
  recycleDays: Number(env.RUNTIME_RECYCLE_DAYS ?? 30) || 30,
  pvcSize: env.RUNTIME_PVC_SIZE || '10Gi',
  readyPollMs: Number(env.RUNTIME_READY_POLL_MS ?? 2000) || 2000,
  // 就绪等待上限：覆盖镜像拉取 + 容器启动的完整窗口；就绪判定按镜像匹配
  // （detectServiceReady），超时后由查询/维护 sweep 继续收敛，状态不会卡死。
  readyTimeoutMs: Number(env.RUNTIME_READY_TIMEOUT_MS ?? 900000) || 900000,
  // 权益失效宽限：失效超过该天数才停机（scale 0，PVC 保留）；0 = 失效即停。
  expireGraceDays: Number.isFinite(Number(env.RUNTIME_EXPIRE_GRACE_DAYS)) ? Number(env.RUNTIME_EXPIRE_GRACE_DAYS) : 1,
  // 停机数据保留：suspended 超过该天数标记 recycle_pending 交人工（删除才含 PVC）。
  suspendKeepDays: Number.isFinite(Number(env.RUNTIME_SUSPEND_KEEP_DAYS)) ? Number(env.RUNTIME_SUSPEND_KEEP_DAYS) : 30,
  // 免密登录：钥匙 et 的 HMAC 密钥（≥32 字符，沙盒启用时必须）与链接有效期。
  accessSecret: env.RUNTIME_ACCESS_SECRET || '',
  accessUrlTtlSeconds: Number(env.RUNTIME_ACCESS_URL_TTL_SECONDS ?? 60) || 60,
  // 用户可选工作目录的根（容器内路径）。设置后实例里的用户只能在它之下选择/
  // 新建工作目录；不设置则不限制（与历史行为一致）。根落在 PVC 的 workspace
  // 子路径上，与 /data 同卷，不额外申请存储。
  workspaceRoot: env.RUNTIME_WORKSPACE_ROOT || '',
};
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
  try { await route(request, response); }
  catch (error) {
    if (error instanceof SafeError) {
      const body = { code: error.code };
      const headers = {};
      if (error.retryAfterSeconds) {
        body.retryAfterSeconds = error.retryAfterSeconds;
        headers['Retry-After'] = String(Math.ceil(error.retryAfterSeconds));
      }
      return send(response, error.status, body, Object.keys(headers).length ? headers : undefined);
    }
    if (error instanceof HubError) {
      const [status, code] = presentHubError(error);
      return send(response, status, { code });
    }
    console.error('unhandled_route_error', JSON.stringify({ stack: String(error?.stack ?? error).slice(0, 300) }));
    send(response, 500, { code: 'internal_error' });
  }
});
server.listen(Number(env.PORT ?? 8780), env.HOST ?? '127.0.0.1', () => console.log('MetaWork official service ready'));
const retention = setInterval(() => {
  try {
    db.prepare("DELETE FROM ai_usage WHERE created_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
    db.prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
    for (const [key, value] of rates) if (value.until < Date.now()) rates.delete(key);
    const cutoff = Date.now();
    for (const [key, value] of emailCodes) if (value.expiresAt < cutoff) emailCodes.delete(key);
    if (hubQueryAt.size > 10000) hubQueryAt.clear();
    // 沙盒生命周期维护（权益宽限停机 / 停机超期回收 / 活跃度回收）：只做标记，删除由人工执行。
    void runtimeMaintenanceSweep();
  } catch (error) {
    // 周期清理绝不把进程打死；本轮放弃，下轮重试。
    console.error('retention_sweep_failed', JSON.stringify({ reason: String(error?.message ?? error).slice(0, 120) }));
  }
}, Number(env.RETENTION_SWEEP_MS ?? 60000));
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
  // 沙盒免密路径（redeem/verify/session）与 AI 一样豁免 per-IP 通用限流：
  // redeem/verify 走 ingress（源 IP 恒为 ingress-controller），verify 更是每请求热路径。
  if (path !== '/v1/ai/operation' && !path.startsWith('/v1/runtime-access/') && !path.startsWith('/_auth/')) rate(`http:${ip}`, Number(env.HTTP_RATE_MAX ?? 120), 60000);
  // /_auth/* 别名：租户 -auth Ingress 无 rewrite，/_auth 前缀原样到达本服务。
  // 免密路径必须与 /v1/runtime-access/* 一并注册——漏掉任何一个，浏览器免密
  // 链接都会落入兜底会话门禁（401 session_invalid）。
  if (request.method === 'GET' && (path === '/v1/runtime-access/redeem' || path === '/_auth/redeem')) return runtimeAccessRedeem(request, response);
  if (request.method === 'GET' && (path === '/v1/runtime-access/verify' || path === '/_auth/verify')) return runtimeAccessVerify(request, response);
  if (request.method === 'POST' && (path === '/v1/runtime-access/session' || path === '/_auth/session')) return runtimeAccessSession(request, response);
  // 控制台静态托管：公开路径（/、/console/*），与 API 前缀（/v1、/admin）无交集；仅 GET、防穿越。
  if (request.method === 'GET') {
    if (path === '/' || path === '/index.html') return serveConsoleStatic(response, 'index.html');
    if (path.startsWith('/console/')) {
      const relative = path.slice('/console/'.length);
      if (!relative || relative.includes('..') || relative.includes('\\')) fail(404, 'not_found');
      return serveConsoleStatic(response, relative);
    }
  }
  if (request.method === 'POST' && path === '/v1/auth/email/code') return emailCodeRoute(response, request, ip);
  if (request.method === 'POST' && ['/v1/auth/login', '/v1/auth/register'].includes(path)) return emailAuthRoute(request, response, ip, path);
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
  const accessUrlMatch = /^\/v1\/runtimes\/([A-Za-z0-9_-]+)\/access-url$/u.exec(path);
  if (request.method === 'POST' && accessUrlMatch) return sandboxAccessUrl(request, response, session, accessUrlMatch[1]);
  const upgradeMatch = /^\/v1\/runtimes\/([A-Za-z0-9_-]+)\/upgrade$/u.exec(path);
  if (request.method === 'POST' && upgradeMatch) return instanceUpgrade(request, response, session, upgradeMatch[1]);
  if (request.method === 'POST' && path === '/v1/runtimes') return createSandbox(request, response, session);
  if (request.method === 'GET' && path === '/v1/runtimes') return sandboxListView(response, session);
  const sandboxMatch = /^\/v1\/runtimes\/([A-Za-z0-9_-]+)$/u.exec(path);
  if (request.method === 'GET' && sandboxMatch) return sandboxDetailView(response, session, sandboxMatch[1]);
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

const CONSOLE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveConsoleStatic(response, relativePath) {
  // 控制台目录相对本文件定位（cwd 无关）；目录不存在（未部署控制台）时按 404 处理。
  const root = resolve(dirname(fileURLToPath(import.meta.url)), 'console-dist');
  const target = resolve(root, relativePath);
  if (!target.startsWith(root)) fail(404, 'not_found');
  let body;
  try { body = readFileSync(target); } catch { fail(404, 'not_found'); }
  const type = CONSOLE_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(body);
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
  if (path === '/v1/admin/email-outbox') {
    // Test-only mail sink: drains the captured stub transport (production answers 404).
    if (env.NODE_ENV !== 'test') fail(404, 'not_found');
    return send(response, 200, { emails: smtpOutbox.splice(0) });
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
  if (path === '/v1/admin/runtimes') {
    // 人工处理台账：停机中/回收标记/失败沙盒；close 是唯一删除入口。
    const rows = db.prepare("SELECT * FROM runtimes WHERE status IN ('suspended', 'recycle_pending', 'failed') ORDER BY created_at DESC LIMIT 200").all();
    return send(response, 200, { runtimes: rows.map(sandboxView) });
  }
  if (path === '/v1/admin/runtimes/close') {
    const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(String(body.sandboxId ?? ''));
    if (!row) fail(404, 'sandbox_not_found');
    if (row.status === 'closed') return send(response, 200, { closed: true });
    if (inflightSandboxes.has(row.id)) fail(409, 'sandbox_provisioning');
    for (const resource of SANDBOX_RESOURCES.slice().reverse()) {
      const result = await k8sRequest('DELETE', `${resource.apiPath}/namespaces/${runtimeEnv.namespace}/${resource.plural}/${sandboxTargetName(resource, sandboxResourceName(row.id))}`);
      if (result.status !== 200 && result.status !== 404) fail(502, 'k8s_delete_failed');
    }
    db.prepare("UPDATE runtimes SET status='closed', updated_at=? WHERE id=?").run(now(), row.id);
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
      // 沙盒门票/会话一并失效：generation +1 让旧门票 Cookie 与已兑换会话全部过期
      db.prepare('UPDATE runtimes SET access_generation = access_generation + 1, updated_at = ? WHERE account_id = ?').run(now(), account.id);
    });
    return send(response, 200, { revoked: true });
  }
  fail(404, 'not_found');
}

// ─── 沙盒环境（托管 Runtime 实例）───────────────────────────────────────────────
// 方案：docs/plans/2026-11-09-official-runtime-provisioning-design.md。免密门禁（L1）
// 与沙盒官方会话（L2）为二期预留，一期域名开放访问。
const TIER_RESOURCES = { small: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } } };
const SANDBOX_STEPS = ['storage', 'workload', 'autoscale', 'network', 'ingress', 'ready'];
// 数组顺序即创建顺序，也是 close 时的逆序删除顺序（PVC 最后删）。
// resourceName：删除/读取时该资源的实际名（PVC 带 -data 后缀，其余与 Deployment 同名）。
const SANDBOX_RESOURCES = [
  { step: 'storage', apiPath: '/api/v1', plural: 'persistentvolumeclaims', resourceName: resourceName => `${resourceName}-data`, manifest: sandboxPvcManifest },
  { step: 'workload', apiPath: '/apis/apps/v1', plural: 'deployments', manifest: sandboxDeploymentManifest },
  { step: 'autoscale', apiPath: '/apis/autoscaling.k8s.io/v1', plural: 'verticalpodautoscalers', manifest: sandboxVpaManifest },
  { step: 'network', apiPath: '/api/v1', plural: 'services', manifest: sandboxServiceManifest },
  { step: 'ingress', apiPath: '/apis/networking.k8s.io/v1', plural: 'ingresses', resourceName: resourceName => `${resourceName}-auth`, manifest: sandboxAuthIngressManifest },
  { step: 'ingress', apiPath: '/apis/networking.k8s.io/v1', plural: 'ingresses', manifest: sandboxIngressManifest },
];
const sandboxTargetName = (resource, name) => (resource.resourceName ? resource.resourceName(name) : name);
const inflightSandboxes = new Set();
// 服务重启打断的 provisioning 沙盒：启动即扫描续跑（管线幂等）。
// 必须推迟到模块加载完成后执行：顶层立即调用会触发 TDZ——provision/k8sConnection 依赖的
// 后置绑定（inflightSandboxes、k8sConnectionCache 等）尚未初始化，表现为启动即静默失败甚至崩溃。
setTimeout(() => {
  try {
    for (const stale of db.prepare("SELECT id FROM runtimes WHERE status = 'provisioning'").all()) void provision(stale.id);
  } catch (error) {
    console.error('sandbox_boot_resume_failed', JSON.stringify({ reason: String(error?.message ?? error).slice(0, 120) }));
  }
}, 0);

async function createSandbox(request, response, session) {
  assertEntitlement(request, session);
  rate(`runtime:${session.account.id}`, Number(env.RUNTIME_RATE_MAX ?? 5), 60000);
  if (!runtimeEnv.image) fail(503, 'sandbox_unavailable');
  const body = await readJson(request);
  requestId(body.idempotencyKey);
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 48)) fail(400, 'invalid_name');
  if (body.tier !== undefined && body.tier !== 'small') fail(400, 'invalid_tier');
  const key = `${session.account.id}:${body.idempotencyKey}`;
  const replay = db.prepare('SELECT * FROM runtimes WHERE idempotency_key = ?').get(key);
  if (replay) return send(response, 202, { sandbox: sandboxView(replay) });
  const active = db.prepare("SELECT id FROM runtimes WHERE account_id = ? AND status IN ('provisioning', 'running', 'updating', 'suspended', 'recycle_pending')").get(session.account.id);
  if (active) fail(409, 'sandbox_exists');
  const row = {
    id: id('rt'), account_id: session.account.id, idempotency_key: key,
    name: body.name ?? null, slug: uniqueSlug(body.name), tier: 'small', image: runtimeEnv.image,
    status: 'provisioning', domain: null, pod_phase: null, vpa_json: null,
    steps_json: JSON.stringify(SANDBOX_STEPS.map(stepName => ({ name: stepName, status: 'pending' }))),
    last_access_at: null, created_at: now(), updated_at: now(),
  };
  // slug 与"一账号一活跃沙盒"都由唯一索引兜底；索引冲突按同一业务错误呈现。
  for (let attempt = 0; attempt < 3; attempt++) {
    row.domain = `${row.slug}.${runtimeEnv.baseDomain}`;
    try {
      db.prepare('INSERT INTO runtimes (id, account_id, idempotency_key, name, slug, tier, image, status, domain, pod_phase, vpa_json, steps_json, last_access_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...Object.values(row));
      break;
    } catch {
      if (db.prepare("SELECT id FROM runtimes WHERE account_id = ? AND status IN ('provisioning', 'running', 'updating', 'suspended', 'recycle_pending')").get(session.account.id)) fail(409, 'sandbox_exists');
      if (attempt === 2) fail(409, 'slug_conflict');
      row.slug = uniqueSlug(body.name);
    }
  }
  void provision(row.id);
  return send(response, 202, { sandbox: sandboxView(row) });
}

async function sandboxDetailView(response, session, sandboxId) {
  const row = db.prepare('SELECT * FROM runtimes WHERE id = ? AND account_id = ?').get(sandboxId, session.account.id);
  if (!row) fail(404, 'sandbox_not_found');
  await refreshLive(row);
  touchLastAccess(row.id, row.last_access_at);
  const fresh = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(sandboxId);
  // 每次查询现签钥匙：Web「进入沙盒」直接用；closed 沙盒不给入口
  const access = fresh.status === 'closed' ? undefined : {
    accessUrl: `https://${fresh.domain}/_auth/redeem?et=${encodeURIComponent(mintAccessEt(fresh).et)}`,
    expiresIn: runtimeEnv.accessUrlTtlSeconds,
  };
  const templateDrifted = await detectTemplateDrift(fresh);
  return send(response, 200, { ...(access ? { access } : {}), sandbox: sandboxView(fresh, templateDrifted) });
}

async function sandboxListView(response, session) {
  const rows = db.prepare('SELECT * FROM runtimes WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(session.account.id);
  for (const row of rows) touchLastAccess(row.id, row.last_access_at);
  // 列表同样要走活性检测：控制台实例页读的是列表，service_ready 缺失时若不在
  // 这里补检测，用户刷新页面就拿不到"进入实例"入口（存量实例该列默认为 0）。
  for (const row of rows) {
    if (row.status === 'running' && !row.service_ready) {
      await refreshLive(row);
    }
  }
  const fresh = rows.map(row => db.prepare('SELECT * FROM runtimes WHERE id = ?').get(row.id) ?? row);
  const views = [];
  for (const row of fresh) {
    views.push(sandboxView(row, await detectTemplateDrift(row)));
  }
  return send(response, 200, { sandboxes: views });
}

function sandboxView(row, templateDrifted = false) {
  const expectedImage = row.image ?? '';
  const appliedImage = row.applied_image ?? '';
  return {
    sandboxId: row.id, name: row.name, tier: row.tier, status: row.status, domain: row.domain,
    // 版本显示**实际运行**的镜像：期望值在点更新按钮的瞬间就变了，拿它当"版本"
    // 会让用户以为新版本已经跑起来了。
    version: imageTag(appliedImage || expectedImage),
    updateAvailable: Boolean(runtimeEnv.image && expectedImage !== runtimeEnv.image
      && ['running', 'suspended'].includes(row.status)),
    latestVersion: imageTag(runtimeEnv.image),
    /** 部署配置已变更，存量实例仍是旧模板：需要重建才能生效。 */
    templateDrifted,
    /** 服务真正可用（容器内 Web 已就绪）。不可用时不提供进入入口。 */
    serviceReady: Boolean(row.service_ready),
    podPhase: row.pod_phase ?? null, resources: TIER_RESOURCES[row.tier] ?? null,
    vpa: row.vpa_json ? JSON.parse(row.vpa_json) : null,
    steps: JSON.parse(row.steps_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function uniqueSlug(rawName) {
  const cleaned = (typeof rawName === 'string' ? rawName : '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 30);
  const base = cleaned.length >= 3 ? cleaned : 'runtime';
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = `${base}-${randomBytes(2).toString('hex')}`;
    if (!db.prepare('SELECT 1 FROM runtimes WHERE slug = ?').get(slug)) return slug;
  }
  fail(409, 'slug_conflict');
}

// 回收信号源：免密门禁（L1）延期后没有 verify/redeem 回调，owner 查询即访问，60 秒节流落库。
function touchLastAccess(sandboxId, lastAccessAt) {
  if (lastAccessAt && Date.parse(lastAccessAt) + 60000 > Date.now()) return;
  db.prepare('UPDATE runtimes SET last_access_at=?, updated_at=? WHERE id=?').run(now(), now(), sandboxId);
}

async function refreshLive(row) {
  // 服务重启打断的 provisioning：查询路径触发续跑（管线幂等）。
  if (row.status === 'provisioning' && !inflightSandboxes.has(row.id)) void provision(row.id);
  // 停机实例的重启入口：续费后权益恢复 usable，owner 回来查询即重启同一实例（数据/域名不变）。
  if (row.status === 'suspended') {
    if (!usable(entitlement(row.account_id))) return;
    const scaled = await scaleSandboxDeployment(sandboxResourceName(row.id), 1);
    if (!(scaled.status >= 200 && scaled.status < 300)) return;
    markStepPending(row.id, 'ready');
    db.prepare("UPDATE runtimes SET status='provisioning', pod_phase=NULL, service_ready=0, updated_at=? WHERE id=? AND status='suspended'").run(now(), row.id);
    void provision(row.id);
    return;
  }
  if (!['provisioning', 'running'].includes(row.status)) return;
  const name = sandboxResourceName(row.id);
  // service_ready 缺失时（后加的列，存量实例为 0）补一次检测：用户刷新页面就
  // 能拿到"进入实例"入口，不必等维护 sweep。
  if (row.status === 'running' && !row.service_ready) {
    const detected = await detectServiceReady(row.id, name, row.image ?? '');
    if (detected.ready) markServiceReady(row.id, row.image ?? '');
  }
  // Pod 名由 Deployment 的 ReplicaSet 生成（带随机后缀），必须按 label 列表查询而不是按名取。
  const pod = await k8sRequest('GET', `/api/v1/namespaces/${runtimeEnv.namespace}/pods?labelSelector=${encodeURIComponent(`app=${name}`)}`);
  if (pod.status === 200) {
    const items = pod.data?.items ?? [];
    const phase = items.find(item => item.status?.phase)?.status?.phase ?? null;
    if (phase !== row.pod_phase) db.prepare('UPDATE runtimes SET pod_phase=?, updated_at=? WHERE id=?').run(phase, now(), row.id);
    // running 只能由管线在五个创建步骤全部 done 后落定；这里的翻转是续跑路径的兜底，
    // 绝不能在创建未完成时被"Pod 已 Ready"抢先（否则失败步骤会被运行态掩盖）。
    const created = JSON.parse(db.prepare('SELECT steps_json FROM runtimes WHERE id = ?').get(row.id)?.steps_json ?? '[]')
      .filter(entry => entry.name !== 'ready')
      .every(entry => entry.status === 'done');
    // 按镜像匹配：旧 Pod 的 Ready 不能代表当前期望镜像已就绪。
    const live = items.filter(item => !item.metadata?.deletionTimestamp);
    const ready = live.some(item => (
      (!row.image || item.spec?.containers?.some(container => container.image === row.image))
      && item.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')
    ));
    if (ready && created && row.status === 'provisioning') {
      markStepDone(row.id, 'ready');
      markServiceReady(row.id, row.image ?? '');
      db.prepare("UPDATE runtimes SET status='running', updated_at=? WHERE id=? AND status='provisioning'").run(now(), row.id);
    }
  }
  const vpa = await k8sRequest('GET', `/apis/autoscaling.k8s.io/v1/namespaces/${runtimeEnv.namespace}/verticalpodautoscalers/${name}`);
  if (vpa.status === 200) {
    const target = vpa.data?.status?.recommendation?.containerRecommendations?.[0]?.target;
    const encoded = target?.cpu || target?.memory ? JSON.stringify({ targetCpu: target.cpu ?? null, targetMemory: target.memory ?? null }) : null;
    if (encoded !== row.vpa_json) db.prepare('UPDATE runtimes SET vpa_json=?, updated_at=? WHERE id=?').run(encoded, now(), row.id);
  }
}

// 六步管线：storage → workload → autoscale → network → ingress → ready。任一步失败：
// 记失败步骤与原因，回滚已建资源（PVC 最后删），整体落 failed；failed/closed 不占一账号名额。
// updating（版本更新）同样走本管线：跳过创建步骤，仅等待新镜像就绪。
async function provision(sandboxId) {
  if (inflightSandboxes.has(sandboxId)) return;
  inflightSandboxes.add(sandboxId);
  try {
    const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(sandboxId);
    if (!row || !['provisioning', 'updating'].includes(row.status)) return;
    const name = sandboxResourceName(sandboxId);
    if (row.status === 'updating') {
      // 版本更新被打断（服务器重启等）：模板 PATCH 幂等，补一次后继续等就绪。
      await patchDeploymentTemplate(name, sandboxDeploymentManifest({ ...row, image: runtimeEnv.image }, name));
      await waitForReady(sandboxId, name);
      return;
    }
    const previousSteps = JSON.parse(row.steps_json);
    const created = [];
    for (const resource of SANDBOX_RESOURCES) {
      if (previousSteps.find(entry => entry.name === resource.step)?.status === 'done') { created.push({ resource, target: sandboxTargetName(resource, name) }); continue; }
      try {
        await applyResource(resource, sandboxTargetName(resource, name), resource.manifest(row, name));
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 120);
        console.error('sandbox_step_failed', JSON.stringify({ step: resource.step, reason }));
        markStepFailed(sandboxId, resource.step, reason);
        await rollbackCreated(created, sandboxId);
        return;
      }
      markStepDone(sandboxId, resource.step);
      created.push({ resource, target: sandboxTargetName(resource, name) });
    }
    await waitForReady(sandboxId, name);
  } catch (error) {
    console.error('sandbox_provision_failed', JSON.stringify({ stage: 'pipeline', reason: String(error?.message ?? error).slice(0, 120) }));
  } finally { inflightSandboxes.delete(sandboxId); }
}

// get-or-create：确定性命名先 get 再 create；并发 409 视为对方已建成（同一沙盒自己的重试路径）。
async function applyResource(resource, target, manifest) {
  const base = `${resource.apiPath}/namespaces/${runtimeEnv.namespace}/${resource.plural}`;
  const existing = await k8sRequest('GET', `${base}/${target}`);
  if (existing.status === 200) return;
  if (existing.status !== 404) throw new Error(k8sReason(existing.status));
  const created = await k8sRequest('POST', base, manifest);
  if (created.status >= 200 && created.status < 300) return;
  if (created.status === 409) return;
  throw new Error(k8sReason(created.status));
}

// 版本更新：strategic-merge patch 整体替换 Pod 模板（镜像+启动脚本随配置一起换）。
async function patchDeploymentTemplate(name, manifest) {
  const result = await k8sRequest('PATCH', `/apis/apps/v1/namespaces/${runtimeEnv.namespace}/deployments/${name}`,
    { spec: { template: manifest.spec.template } },
    { 'Content-Type': 'application/strategic-merge-patch+json' });
  if (result.status >= 200 && result.status < 300) return result;
  if (result.status === 404) throw new Error('k8s_404');
  throw new Error(k8sReason(result.status));
}

/** env 规范化：按 name 排序的 name=value 集合（K8s 不保证列表顺序）。 */
function normalizeEnv(env) {
  return (env ?? [])
    .filter(entry => entry && typeof entry.name === 'string')
    .map(entry => `${entry.name}=${entry.value ?? ''}`)
    .sort()
    .join('\n');
}

/** 挂载规范化：name:mountPath:subPath。 */
function normalizeMounts(mounts) {
  return (mounts ?? [])
    .map(mount => `${mount.name}:${mount.mountPath}:${mount.subPath ?? ''}`)
    .sort()
    .join('\n');
}

/**
 * 存量 Deployment 是否已偏离当前配置生成的模板。
 *
 * 官方服务的部署模板随配置变化（新增环境变量、挂载、initContainer、镜像），
 * 但模板只在**创建实例**或**版本更新**时才会写进集群。配置在实例创建之后
 * 变更时，存量实例的 Deployment 仍是老模板——新增的工作目录根限制、持久化
 * 挂载等都不会生效。这里比对关键字段，把漂移显式暴露出来，让用户能重建实例
 * 而不是永远停在"配置了却不生效"。
 */
function deploymentTemplateDrifted(actual, expected) {
  const actualSpec = actual?.spec?.template?.spec;
  const expectedSpec = expected?.spec?.template?.spec;
  // 没有 Deployment 可比（实例尚未创建）不是漂移。
  if (!actualSpec) return false;
  if (!expectedSpec) return true;
  const actualContainer = actualSpec.containers?.[0];
  const expectedContainer = expectedSpec.containers?.[0];
  if (!actualContainer || !expectedContainer) return true;
  if (actualContainer.image !== expectedContainer.image) return true;
  if (normalizeEnv(actualContainer.env) !== normalizeEnv(expectedContainer.env)) return true;
  if (normalizeMounts(actualContainer.volumeMounts) !== normalizeMounts(expectedContainer.volumeMounts)) return true;
  // startScript 携带镜像发布号：发布号变了也必须重建，否则容器继续跑旧 release。
  if (JSON.stringify(actualContainer.args ?? null) !== JSON.stringify(expectedContainer.args ?? null)) return true;
  if ((actualSpec.initContainers?.length ?? 0) !== (expectedSpec.initContainers?.length ?? 0)) return true;
  return false;
}

/** 读集群里实际的 Deployment 并与当前模板比对；读不到按"无漂移"处理。 */
async function detectTemplateDrift(row) {
  if (!row?.id) return false;
  const name = sandboxResourceName(row.id);
  const actual = await k8sRequest('GET', `/apis/apps/v1/namespaces/${runtimeEnv.namespace}/deployments/${name}`);
  if (actual.status !== 200) return false;
  const expected = sandboxDeploymentManifest({ ...row, image: runtimeEnv.image }, name);
  return deploymentTemplateDrifted(actual.data, expected);
}

function imageTag(image) {
  const value = String(image ?? '');
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  return colon > slash ? value.slice(colon + 1) : value;
}

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 判定实例的 Web 服务是否真正就绪。
 *
 * 必须按镜像匹配：Recreate 策略下 patch 模板后旧 Pod 还在（terminating，
 * Ready 仍为 True），只看"有没有 Ready 的 Pod"会把旧 Pod 当成新 Pod，升级
 * 瞬间就报"完成"。同时排除 terminating 的 Pod，并等待 Deployment rollout
 * 收敛——那是"新 Pod 已经接管"的权威信号。
 */
async function detectServiceReady(sandboxId, podName, expectedImage) {
  const pod = await k8sRequest('GET', `/api/v1/namespaces/${runtimeEnv.namespace}/pods?labelSelector=${encodeURIComponent(`app=${podName}`)}`);
  if (pod.status !== 200) return { ready: false, phase: null };
  const items = pod.data?.items ?? [];
  const live = items.filter(item => !item.metadata?.deletionTimestamp);
  const phase = live.find(item => item.status?.phase)?.status?.phase ?? null;
  const target = String(expectedImage ?? '');
  const ready = live.some(item => (
    // 镜像必须与期望一致：否则这是尚未被替换的旧 Pod。
    (!target || item.spec?.containers?.some(container => container.image === target))
    && item.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')
  ));
  if (!ready) return { ready: false, phase };
  // Pod 已就绪；再看 Deployment 是否收敛（observedGeneration 追上且副本就位）。
  // status 缺失时无法判定，不因此阻塞——镜像匹配 + Ready 已是充分证据。
  const deployment = await k8sRequest('GET', `/apis/apps/v1/namespaces/${runtimeEnv.namespace}/deployments/${podName}`);
  if (deployment.status === 200 && deployment.data?.status) {
    const status = deployment.data.status;
    const generation = deployment.data?.metadata?.generation ?? 0;
    const observed = status.observedGeneration ?? 0;
    const replicas = status.replicas ?? 0;
    const updated = status.updatedReplicas ?? 0;
    const available = status.availableReplicas ?? 0;
    if (observed < generation || updated < replicas || available < replicas) {
      return { ready: false, phase };
    }
  }
  return { ready: true, phase };
}

/** 就绪落库：实际运行镜像 + 可用标志 + 进度完成。 */
function markServiceReady(sandboxId, appliedImage) {
  db.prepare('UPDATE runtimes SET applied_image=?, service_ready=1, updated_at=? WHERE id=?')
    .run(appliedImage, now(), sandboxId);
}

/** 不可用落库：进入/退出就绪期时清标志，避免前端继续给出进入入口。 */
function markServiceNotReady(sandboxId) {
  db.prepare('UPDATE runtimes SET service_ready=0, updated_at=? WHERE id=?').run(now(), sandboxId);
}

async function waitForReady(sandboxId, podName) {
  const deadline = Date.now() + runtimeEnv.readyTimeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status, image FROM runtimes WHERE id = ?').get(sandboxId);
    if (!row || !['provisioning', 'updating'].includes(row.status)) return;
    const expectedImage = row.image ?? '';
    const detected = await detectServiceReady(sandboxId, podName, expectedImage);
    db.prepare('UPDATE runtimes SET pod_phase=?, updated_at=? WHERE id=?').run(detected.phase, now(), sandboxId);
    if (detected.ready) {
      markStepDone(sandboxId, 'ready');
      markServiceReady(sandboxId, expectedImage);
      db.prepare("UPDATE runtimes SET status='running', updated_at=? WHERE id=? AND status IN ('provisioning','updating')").run(now(), sandboxId);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, runtimeEnv.readyPollMs));
  }
  // Ready 超时：保持 provisioning，ready 留 pending；下次查询触发续跑继续等待。
}

async function rollbackCreated(created, sandboxId) {
  db.prepare("UPDATE runtimes SET status='failed', updated_at=? WHERE id=? AND status='provisioning'").run(now(), sandboxId);
  for (const item of created.slice().reverse()) {
    await k8sRequest('DELETE', `${item.resource.apiPath}/namespaces/${runtimeEnv.namespace}/${item.resource.plural}/${item.target}`);
  }
}

function mutateSteps(sandboxId, mutate) {
  const row = db.prepare('SELECT steps_json FROM runtimes WHERE id = ?').get(sandboxId);
  if (!row) return;
  const steps = JSON.parse(row.steps_json);
  mutate(steps);
  db.prepare('UPDATE runtimes SET steps_json=?, updated_at=? WHERE id=?').run(JSON.stringify(steps), now(), sandboxId);
}

function markStepDone(sandboxId, stepName) {
  mutateSteps(sandboxId, steps => {
    const entry = steps.find(item => item.name === stepName);
    if (entry) { entry.status = 'done'; entry.at = now(); delete entry.reason; }
  });
}

function markStepFailed(sandboxId, stepName, reason) {
  mutateSteps(sandboxId, steps => {
    const entry = steps.find(item => item.name === stepName);
    if (entry) { entry.status = 'failed'; entry.reason = reason; }
  });
  db.prepare("UPDATE runtimes SET status='failed', updated_at=? WHERE id=? AND status='provisioning'").run(now(), sandboxId);
}

function markStepPending(sandboxId, stepName) {
  mutateSteps(sandboxId, steps => {
    const entry = steps.find(item => item.name === stepName);
    if (entry) { entry.status = 'pending'; delete entry.at; delete entry.reason; }
  });
}

// 资源名：mw-rt-<24 位 hex（去前缀的沙盒 id）>，确定性命名是幂等与续跑的基础。
function sandboxResourceName(sandboxId) { return `mw-rt-${sandboxId.slice(3)}`; }

function sandboxLabels(sandboxId) {
  // NetworkPolicy 与运维筛选都靠这些标签；label 值不含下划线（K8s 合法字符限制）。
  return {
    'app.kubernetes.io/part-of': 'metawork-sandbox',
    'app.kubernetes.io/managed-by': 'metawork-official-server',
    'metawork.sandbox/id': sandboxId.replace(/_/u, '-'),
  };
}

function sandboxPvcManifest(row, name) {
  return {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: `${name}-data`, namespace: runtimeEnv.namespace, labels: { ...sandboxLabels(row.id), app: `${name}-data` } },
    spec: {
      accessModes: ['ReadWriteOnce'], storageClassName: runtimeEnv.storageClass,
      resources: { requests: { storage: runtimeEnv.pvcSize } },
    },
  };
}

function sandboxDeploymentManifest(row, name) {
  const labels = { app: name, ...sandboxLabels(row.id) };
  // 容器直跑镜像（见 ADR-0056）：镜像即版本，PVC 只放数据。启动脚本只做三件事——
  // 清遗留运行锁、建 app/current 兼容层（Runtime 多处按
  // appCurrent/dist 查找 schema 与扩展，指向 /app 即可零改动工作）、前台启动。
  // 不再拷贝 release：创建/升级从 5-30+ 分钟降到拉镜像 + 起进程的分钟级。
  const clearStaleLock = 'rm -f /data/anyfusion/data/runtime.lock;';
  const linkAppCurrent = 'mkdir -p /data/anyfusion/app && ln -sfn /app /data/anyfusion/app/current;';
  const startScript = `${clearStaleLock} ${linkAppCurrent} exec node /app/dist/index.js server start`;
  // 可选的工作目录根：用户只能在它之下选择/新建工作目录。
  // 根目录落在 PVC 的 workspace 子路径上（与 /data 同卷，不额外申请存储）。
  // subPath 挂载要求子目录在卷上已存在，否则 kubelet FailedMount —— 所以必须由
  // initContainer 挂整卷先建好目录。
  const workspaceRoot = runtimeEnv.workspaceRoot;
  const workspaceVolumeMounts = workspaceRoot
    ? [
      { name: 'data', mountPath: '/workspace', subPath: 'workspace' },
    ]
    : [];
  const workspaceInitContainers = workspaceRoot
    ? [{
      name: 'workspace-init',
      image: row.image,
      imagePullPolicy: 'IfNotPresent',
      command: ['/bin/sh', '-c'],
      // 挂整卷（不带 subPath）：subPath 目标此时还不存在。
      args: ['mkdir -p /workspace && chmod 700 /workspace'],
      volumeMounts: [{ name: 'data', mountPath: '/workspace' }],
      resources: TIER_RESOURCES[row.tier],
    }]
    : [];
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: runtimeEnv.namespace, labels },
    spec: {
      replicas: 1, strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          ...(workspaceInitContainers.length ? { initContainers: workspaceInitContainers } : {}),
          containers: [{
            name: 'server', image: row.image, imagePullPolicy: 'IfNotPresent',
            command: ['/bin/sh', '-c'], args: [startScript],
            env: [
              // 监听地址（ADR-0056 后主线的 env 契约）：0.0.0.0 才能让 kubelet
              // 探针从 Pod 外打进 8788；缺省 loopback 会让实例永远卡"部署中"。
              { name: 'METAWORK_SERVER_HOST', value: '0.0.0.0' },
              // 旧名保留给 ≤0.1.25.9 镜像线；0.1.27+ 只读 METAWORK_SERVER_HOST。
              { name: 'METAWORK_WEB_HOST', value: '0.0.0.0' },
              { name: 'METAWORK_WEB_PORT', value: String(runtimeEnv.port) },
              // 非 macOS 容器强制要求：凭据走文件 SecretStore（无 Keychain，缺省启动即崩）。
              { name: 'METAWORK_SECRET_STORE', value: 'file' },
              // 沙盒 Runtime 指向的官方服务：显式钉生产域名（源码烘焙默认是 huoshan 9222 开发入口），
              // 客户端强制 HTTPS，不能走集群内 Service 的 http；不设置则沙盒登录/权益会指向错误环境。
              { name: 'METAWORK_OFFICIAL_SERVER_URL', value: env.RUNTIME_OFFICIAL_SERVER_URL || 'https://metawork.nexusfusionai.com' },
              // 渲染 Planner/Codex/Pi 配置模板必须非空；占位即可（镜像内不含真实 Provider）。
              { name: 'OPENAI_BASE_URL', value: env.RUNTIME_OPENAI_BASE_URL || 'https://api.deepseek.com' },
              // 用户可选工作目录的根：限制在它之下选择/新建工作目录（未配置则不限制）。
              ...(workspaceRoot ? [{ name: 'METAWORK_WORKSPACE_ROOT', value: workspaceRoot }] : []),
              // 容器直跑镜像（见 ADR-0056）：全新 PVC 无 active 配置时，server 启动
              // 自动播种最小配置（占位 Provider + 三套 harness/AgentClass 骨架）。
              { name: 'METAWORK_CONTAINER_BOOTSTRAP', value: '1' },
            ],
            ports: [{ name: 'web', containerPort: runtimeEnv.port }],
            // 直跑镜像后启动只剩拉镜像 + 起进程；探针沿用现成清单的 GET /。
            readinessProbe: { httpGet: { path: '/', port: 'web' }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 60 },
            resources: TIER_RESOURCES[row.tier],
            volumeMounts: [
              { name: 'data', mountPath: '/data' },
              ...workspaceVolumeMounts,
            ],
          }],
          // 私有仓库拉取凭据（可选）：Secret 需预先建在同 namespace（docker-registry 类型）。
          ...(env.RUNTIME_IMAGE_PULL_SECRET ? { imagePullSecrets: [{ name: env.RUNTIME_IMAGE_PULL_SECRET }] } : {}),
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }],
        },
      },
    },
  };
}

function sandboxVpaManifest(row, name) {
  return {
    apiVersion: 'autoscaling.k8s.io/v1', kind: 'VerticalPodAutoscaler',
    metadata: { name, namespace: runtimeEnv.namespace, labels: sandboxLabels(row.id) },
    spec: {
      targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
      updatePolicy: { updateMode: 'Auto' },
      resourcePolicy: {
        containerPolicies: [{
          containerName: 'server', controlledResources: ['cpu', 'memory'],
          minAllowed: { cpu: '250m', memory: '512Mi' }, maxAllowed: { cpu: '4', memory: '8Gi' },
        }],
      },
    },
  };
}

function sandboxServiceManifest(row, name) {
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: runtimeEnv.namespace, labels: sandboxLabels(row.id) },
    spec: {
      type: 'ClusterIP', selector: { app: name },
      ports: [{ name: 'web', port: runtimeEnv.port, targetPort: 'web' }],
    },
  };
}

function sandboxAuthIngressManifest(row, name) {
  // 免密兑换入口：/_auth 直通官方服务（同 namespace Service）。
  // 该 Ingress 只承载 /_auth（无门禁，任意访问都可达）；沙盒本体路径由主 Ingress 承载。
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: { name: `${name}-auth`, namespace: runtimeEnv.namespace, labels: sandboxLabels(row.id) },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [row.domain], secretName: runtimeEnv.tlsSecret }],
      rules: [{
        host: row.domain,
        http: { paths: [{ path: '/_auth', pathType: 'Prefix', backend: { service: { name: 'metawork-official', port: { number: 80 } } } }] },
      }],
    },
  };
}

function sandboxIngressManifest(row, name) {
  const domain = row.domain;
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
    metadata: {
      name, namespace: runtimeEnv.namespace, labels: sandboxLabels(row.id),
      annotations: {
        // 不设 auth-url 门禁：沙盒域名可直接访问，用户在沙盒内用账号密码登录官方账号。
        // 免密链接（/_auth/redeem → /_sandbox/exchange）是省去输密码的快捷方式，不是准入条件。
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-buffering': 'off',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [domain], secretName: runtimeEnv.tlsSecret }],
      rules: [{
        host: domain,
        http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: runtimeEnv.port } } } }] },
      }],
    },
  };
}

// K8s API：生产固定 in-cluster ServiceAccount（token/CA 由挂载卷提供）；测试经 K8S_API_BASE 指向本地桩。
let k8sConnectionCache = null;
function k8sConnection() {
  if (k8sConnectionCache) return k8sConnectionCache;
  if (env.K8S_API_BASE) {
    k8sConnectionCache = { base: env.K8S_API_BASE.replace(/\/+$/u, ''), token: () => env.K8S_API_TOKEN ?? 'test-token' };
    return k8sConnectionCache;
  }
  let cachedToken = null;
  k8sConnectionCache = {
    base: 'https://kubernetes.default.svc',
    ca: readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8'),
    token: () => (cachedToken ??= readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim()),
  };
  return k8sConnectionCache;
}

// 永不 reject：非 2xx/网络错误/超时都以 { status, data } 回来，管线按 status 分支处理。
function k8sRequest(method, apiPath, manifest, extraHeaders) {
  let config;
  try { config = k8sConnection(); } catch { return Promise.resolve({ status: 0, data: null }); }
  const url = new URL(`${config.base}${apiPath}`);
  const payload = manifest === undefined ? null : JSON.stringify(manifest);
  return new Promise(resolve => {
    let token;
    try { token = config.token(); } catch { return resolve({ status: 0, data: null }); }
    const handle = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      method,
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      ...(url.protocol === 'https:' ? { ca: config.ca, servername: url.hostname } : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: response.statusCode, data });
      });
    });
    // 挂起的 API server 不能把管线永远钉在 inflight；超时按不可达处理，由续跑机制重试。
    handle.setTimeout(10000, () => handle.destroy(new Error('k8s_request_timeout')));
    handle.on('error', error => { console.error('k8s_request_error', JSON.stringify({ method, path: apiPath, code: error?.code ?? 'unknown', message: String(error?.message ?? '').slice(0, 80) })); resolve({ status: 0, data: null }); });
    if (payload) handle.write(payload);
    handle.end();
  });
}

function k8sReason(status) { return status === 0 ? 'k8s_unreachable' : `k8s_${status ?? 'unknown'}`; }

// ─── 免密登录（钥匙 et / 门票 Cookie / 会话兑换）─────────────────────────────────
// 交互：access-url 现签 et → redeem 校验并种长期门票 Cookie → 租户 Runtime 凭 et 兑换
// 官方会话（本进程代 owner 签发）→ 采纳后权益 active。et 一次性（会话兑换即焚）、
// 绑定 账号+沙盒+域名+access_generation；门票长期有效，随 revoke/access_generation 失效。
const accessEts = new Map(); // digest → { accountId, sandboxId, generation, exp, gateDone }
function accessEtDigest(et) { return String(et); }

function mintAccessEt(row) {
  const exp = Date.now() + runtimeEnv.accessUrlTtlSeconds * 1000;
  const nonce = randomBytes(8).toString('hex');
  const payload = `${row.account_id}|${row.id}|${row.access_generation ?? 1}|${row.domain}|${exp}|${nonce}`;
  const et = `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', runtimeEnv.accessSecret).update(payload).digest('base64url')}`;
  accessEts.set(accessEtDigest(et), { accountId: row.account_id, sandboxId: row.id, domain: row.domain, generation: row.access_generation ?? 1, exp, gateDone: false });
  if (accessEts.size > 10000) for (const [key, value] of accessEts) if (value.exp < Date.now()) accessEts.delete(key);
  return { et, expiresIn: runtimeEnv.accessUrlTtlSeconds };
}

function validateAccessEt(et) {
  const key = accessEtDigest(String(et ?? ''));
  const entry = accessEts.get(key);
  const mapHit = Boolean(entry);
  const expOk = Boolean(entry) && entry.exp >= Date.now();
  console.error('validate_et', JSON.stringify({ keyLen: key.length, keyTail: key.slice(-12), mapHit, expOk, now: Date.now() }));
  if (!entry || !expOk) return null;
  const row = db.prepare('SELECT access_generation, domain, status FROM runtimes WHERE id = ?').get(entry.sandboxId);
  const rowOk = Boolean(row) && Number(row.access_generation) === Number(entry.generation) && row.domain === entry.domain && row.status !== 'closed';

  if (!rowOk) return null;
  return entry;
}

// 免密票据解析（历史门禁遗留）：现在只用于 verify 端点的活跃度信号记录，不再阻断访问。
function validateGateCookie(cookieHeader, sandboxId) {
  try {
    const raw = String(cookieHeader ?? '').split(/;\s*/).find(part => part.startsWith('mw_rt='))?.slice(6) ?? '';
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8');
    const expected = createHmac('sha256', runtimeEnv.accessSecret).update(payload).digest('base64url');
    if (!timingSafeEqual(Buffer.from(raw.slice(dot + 1)), Buffer.from(expected))) return null;
    const [accountId, cookieSandboxId, generation] = payload.split('|');
    if (sandboxId && cookieSandboxId !== sandboxId) return null;
    const row = db.prepare('SELECT access_generation, account_id FROM runtimes WHERE id = ?').get(cookieSandboxId);
    if (!row || Number(row.access_generation) !== Number(generation) || row.account_id !== accountId) return null;
    return { accountId, sandboxId: cookieSandboxId, generation: Number(generation) };
  } catch { return null; }
}

function runtimeAccessRedeem(request, response) {
  const et = new URL(request.url ?? '/', 'http://localhost').searchParams.get('et') ?? '';
  const entry = validateAccessEt(et);
  if (!entry) fail(401, 'sandbox_access_invalid');
  const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(entry.sandboxId);
  if (!row || row.status === 'closed') fail(401, 'sandbox_access_invalid');
  // et 必须先经 redeem 才有资格兑换官方会话（防止 et 被直接拿去换会话）。
  accessEts.get(accessEtDigest(et)).gateDone = true;
  send(response, 302, null, {
    Location: `https://${row.domain}/_sandbox/exchange?et=${encodeURIComponent(et)}`,
  });
}

function runtimeAccessVerify(request, response) {
  // 门禁已移除（沙盒域名可直接访问）；此端点保留为「免密会话活跃度信号」：
  // 带门票的请求刷新该沙盒的 last_access_at（停机/回收判据的数据源），60 秒节流。
  const identity = validateGateCookie(request.headers.cookie, null);
  if (!identity) return send(response, 200, { ok: true, tracked: false });
  const row = db.prepare('SELECT id, access_generation, account_id, last_access_at FROM runtimes WHERE id = ?').get(identity.sandboxId);
  if (!row || Number(row.access_generation) !== Number(identity.generation)) return send(response, 200, { ok: true, tracked: false });
  touchLastAccess(row.id, row.last_access_at);
  return send(response, 200, { ok: true, tracked: true });
}

async function runtimeAccessSession(request, response) {
  const body = await readJson(request);
  const et = typeof body.et === 'string' ? body.et : '';
  const entry = validateAccessEt(et);
  const state = entry && accessEts.get(accessEtDigest(et));
  if (!entry || !state.gateDone) fail(401, 'sandbox_access_invalid');
  accessEts.delete(accessEtDigest(et)); // 会话兑换后钥匙永久作废
  const sessionToken = randomBytes(32).toString('base64url');
  // instance_id 记录沙盒来源；会话遵循内存态纪律（存活于租户 Runtime，沙盒重启后重入免密恢复）
  db.prepare('INSERT INTO sessions (id, account_id, token_digest, instance_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id('ses'), entry.accountId, digest(sessionToken), entry.sandboxId, now(), now());
  return send(response, 200, {
    sessionToken,
    account: accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(entry.accountId)),
    entitlement: entitlement(entry.accountId),
  });
}

function sandboxAccessUrl(request, response, session, sandboxId) {
  assertEntitlement(request, session);
  rate(`runtime-access:${session.account.id}`, Number(env.RUNTIME_ACCESS_RATE_MAX ?? 20), 60000);
  const row = db.prepare('SELECT * FROM runtimes WHERE id = ? AND account_id = ?').get(sandboxId, session.account.id);
  if (!row) fail(404, 'sandbox_not_found');
  if (row.status === 'closed') fail(409, 'sandbox_closed');
  const { et, expiresIn } = mintAccessEt(row);
  return send(response, 200, {
    accessUrl: `https://${row.domain}/_auth/redeem?et=${encodeURIComponent(et)}`,
    expiresIn,
  });
}

// 实例版本更新：把存量 Deployment 滚动到当前配置镜像（RUNTIME_IMAGE）。
// running → updating →（install-cli update + 就绪）→ running；suspended → 模板即换，下次启动生效。
async function instanceUpgrade(request, response, session, sandboxId) {
  assertEntitlement(request, session);
  rate(`instance-upgrade:${session.account.id}`, Number(env.RUNTIME_UPGRADE_RATE_MAX ?? 10), 60000);
  const row = db.prepare('SELECT * FROM runtimes WHERE id = ? AND account_id = ?').get(sandboxId, session.account.id);
  if (!row) fail(404, 'sandbox_not_found');
  if (!runtimeEnv.image) fail(503, 'instance_unavailable');
  // 状态门禁在前：终态/部署中/更新中的实例不可升级。
  if (!['provisioning', 'running', 'suspended', 'updating', 'recycle_pending'].includes(row.status)) fail(409, 'instance_not_upgradable');
  const name = sandboxResourceName(sandboxId);
  const expectedManifest = sandboxDeploymentManifest({ ...row, image: runtimeEnv.image }, name);
  // 镜像相同不一定是"已是最新"：部署配置（环境变量、挂载、initContainer、发布号）
  // 变更后存量实例仍是旧模板，必须允许重建才能让新配置生效。
  const actualDeployment = await k8sRequest('GET', `/apis/apps/v1/namespaces/${runtimeEnv.namespace}/deployments/${name}`);
  const drifted = actualDeployment.status === 200
    && deploymentTemplateDrifted(actualDeployment.data, expectedManifest);
  if (row.image === runtimeEnv.image && !drifted) fail(409, 'already_latest');
  if (inflightSandboxes.has(sandboxId)) fail(409, 'instance_busy');
  const patched = await patchDeploymentTemplate(name, expectedManifest);
  if (!(patched.status >= 200 && patched.status < 300)) fail(502, 'k8s_update_failed');
  if (row.status === 'suspended') {
    // 停机实例：模板即换，下次启动生效；服务此刻并未可用。
    db.prepare('UPDATE runtimes SET image=?, service_ready=0, updated_at=? WHERE id=?').run(runtimeEnv.image, now(), sandboxId);
    return send(response, 200, { sandbox: sandboxView(db.prepare('SELECT * FROM runtimes WHERE id = ?').get(sandboxId)) });
  }
  // 进入更新中：进度回到未完成，服务标记为不可用（前端据此隐藏进入入口）。
  db.prepare("UPDATE runtimes SET image=?, status='updating', service_ready=0, updated_at=? WHERE id=? AND status IN ('running','suspended')")
    .run(runtimeEnv.image, now(), sandboxId);
  mutateSteps(sandboxId, steps => {
    const entry = steps.find(item => item.name === 'ready');
    if (entry) { entry.status = 'pending'; delete entry.at; delete entry.reason; }
  });
  void pollInstanceReadyAfterUpgrade(sandboxId, name);
  return send(response, 202, { sandbox: sandboxView(db.prepare('SELECT * FROM runtimes WHERE id = ?').get(sandboxId)) });
}

// 更新轮询：新 Pod 真正就绪才回 running；超时保持 updating，查询/续跑机制接管。
async function pollInstanceReadyAfterUpgrade(sandboxId, podName) {
  const deadline = Date.now() + runtimeEnv.readyTimeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status, image FROM runtimes WHERE id = ?').get(sandboxId);
    if (!row || row.status !== 'updating') return;
    const detected = await detectServiceReady(sandboxId, podName, row.image ?? '');
    db.prepare('UPDATE runtimes SET pod_phase=?, updated_at=? WHERE id=?').run(detected.phase, now(), sandboxId);
    if (detected.ready) {
      markStepDone(sandboxId, 'ready');
      markServiceReady(sandboxId, row.image ?? '');
      db.prepare("UPDATE runtimes SET status='running', updated_at=? WHERE id=? AND status='updating'").run(now(), sandboxId);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, runtimeEnv.readyPollMs));
  }
}

// 停机/重启都是对 Deployment 的 scale 子资源做 merge-patch（replicas 0 或 1）。
function scaleSandboxDeployment(name, replicas) {
  return k8sRequest('PATCH', `/apis/apps/v1/namespaces/${runtimeEnv.namespace}/deployments/${name}/scale`,
    { spec: { replicas } }, { 'Content-Type': 'application/merge-patch+json' });
}

// 生命周期维护 sweep（随 retention 周期执行，重入保护）：
// running + 权益失效超宽限 → scale 0 → suspended（PVC 保留）
// suspended 超保留期 → recycle_pending（人工处理，删除才含 PVC）
// running + 30 天无本人访问 → recycle_pending（与权益无关的活跃度回收）
let maintenanceInflight = false;
async function runtimeMaintenanceSweep() {
  if (maintenanceInflight) return;
  maintenanceInflight = true;
  try {
    const graceMs = runtimeEnv.expireGraceDays * 86400000;
    for (const item of db.prepare("SELECT r.id, r.account_id, a.disabled FROM runtimes r JOIN accounts a ON a.id = r.account_id WHERE r.status = 'running'").all()) {
      let expiredForMs = null;
      if (item.disabled) expiredForMs = Infinity;
      else {
        const facts = entitlement(item.account_id);
        if (usable(facts)) continue;
        expiredForMs = facts.expiresAt ? Date.now() - Date.parse(facts.expiresAt) : Infinity;
      }
      if (expiredForMs !== Infinity && expiredForMs <= graceMs) continue;
      const scaled = await scaleSandboxDeployment(sandboxResourceName(item.id), 0);
      if (!(scaled.status >= 200 && scaled.status < 300)) {
        console.error('sandbox_suspend_scale_failed', JSON.stringify({ sandboxId: item.id, reason: k8sReason(scaled.status) }));
        continue;
      }
      const marked = db.prepare("UPDATE runtimes SET status='suspended', suspend_at=?, service_ready=0, updated_at=? WHERE id=? AND status='running'").run(now(), now(), item.id);
      if (marked.changes > 0) console.error('sandbox_suspended', JSON.stringify({ sandboxId: item.id, disabled: Boolean(item.disabled) }));
    }
    const suspendCutoff = new Date(Date.now() - runtimeEnv.suspendKeepDays * 86400000).toISOString();
    // 停机保留期从 suspend_at（停机时刻）起算，不受 suspended 期间查询刷新 updated_at 的影响。
    if (db.prepare("SELECT id FROM runtimes WHERE status='suspended' AND coalesce(suspend_at, updated_at) < ? LIMIT 1").get(suspendCutoff)) {
      const recycled = db.prepare("UPDATE runtimes SET status='recycle_pending', updated_at=? WHERE status='suspended' AND coalesce(suspend_at, updated_at) < ?").run(now(), suspendCutoff);
      if (recycled.changes > 0) console.error('sandbox_recycle_marked', JSON.stringify({ count: recycled.changes }));
    }
    const accessCutoff = new Date(Date.now() - runtimeEnv.recycleDays * 86400000).toISOString();
    if (db.prepare("SELECT id FROM runtimes WHERE status='running' AND coalesce(last_access_at, created_at) < ? LIMIT 1").get(accessCutoff)) {
      const recycled = db.prepare("UPDATE runtimes SET status='recycle_pending', updated_at=? WHERE status='running' AND coalesce(last_access_at, created_at) < ?").run(now(), accessCutoff);
      if (recycled.changes > 0) console.error('sandbox_recycle_marked', JSON.stringify({ count: recycled.changes }));
    }
    // 就绪兜底：管线等待超时（安装期超过 readyTimeoutMs）后，没有查询也会把已就绪的实例收敛为 running。
    for (const item of db.prepare("SELECT id FROM runtimes WHERE status = 'provisioning'").all()) {
      const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(item.id);
      if (!row) continue;
      const steps = JSON.parse(row.steps_json);
      const created = steps.filter(entry => entry.name !== 'ready').every(entry => entry.status === 'done');
      if (!created) continue; // 创建步骤未完成：等管线自己推进
      const detected = await detectServiceReady(row.id, sandboxResourceName(row.id), row.image ?? '');
      if (!detected.ready) continue;
      markStepDone(row.id, 'ready');
      markServiceReady(row.id, row.image ?? '');
      db.prepare("UPDATE runtimes SET status='running', updated_at=? WHERE id=? AND status='provisioning'").run(now(), row.id);
      console.error('sandbox_ready_converged', JSON.stringify({ sandboxId: row.id }));
    }
    // 更新兜底：升级轮询超时（安装期超过 readyTimeoutMs）后没有查询也会收敛。
    // 同样按镜像匹配判定——旧 Pod 的 Ready 不能代表新版本已就绪。
    for (const item of db.prepare("SELECT id FROM runtimes WHERE status = 'updating'").all()) {
      const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(item.id);
      if (!row) continue;
      const detected = await detectServiceReady(row.id, sandboxResourceName(row.id), row.image ?? '');
      if (!detected.ready) continue;
      markStepDone(row.id, 'ready');
      markServiceReady(row.id, row.image ?? '');
      db.prepare("UPDATE runtimes SET status='running', updated_at=? WHERE id=? AND status='updating'").run(now(), row.id);
      console.error('sandbox_upgrade_converged', JSON.stringify({ sandboxId: row.id }));
    }
    // 存量收敛：service_ready 是后加的列，升级官方服务前创建的实例该字段为 0，
    // 若无人在写入就永远拿不到"进入实例"入口。这里重新检测一次就绪并补写
    // applied_image / service_ready。
    for (const item of db.prepare("SELECT id FROM runtimes WHERE status = 'running' AND service_ready = 0").all()) {
      const row = db.prepare('SELECT * FROM runtimes WHERE id = ?').get(item.id);
      if (!row) continue;
      const detected = await detectServiceReady(row.id, sandboxResourceName(row.id), row.image ?? '');
      if (!detected.ready) continue;
      markServiceReady(row.id, row.image ?? '');
      console.error('sandbox_service_ready_reconciled', JSON.stringify({ sandboxId: row.id }));
    }
  } catch (error) {
    console.error('sandbox_maintenance_failed', JSON.stringify({ reason: String(error?.message ?? error).slice(0, 120) }));
  } finally { maintenanceInflight = false; }
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

/**
 * OPC auth errors are translated here, locally; they must never reach the top-level presentHubError,
 * which speaks payment codes (a plain 429 would surface as payment_hub_busy).
 */
function shanghaiDay() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }

/** Best-effort local abuse breaker for the unauthenticated mail trigger. Upstream successes only. */
function chargeEmailCodeBudget() {
  const day = shanghaiDay();
  const entry = rates.get(`email-code-daily:${day}`);
  if (entry && entry.until > Date.now()) entry.count += 1;
  else rates.set(`email-code-daily:${day}`, { count: 1, until: Date.parse(`${day}T00:00:00+08:00`) + 86400000 });
}

async function emailCodeRoute(response, request, ip) {
  if (!mailer) fail(503, 'email_unavailable');
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(400, 'invalid_email');
  rate(`auth:${ip}`, Number(env.AUTH_RATE_MAX ?? 10), 60000);
  rate(`email-code:${email}`, 5, 15 * 60000);
  const budgetKey = `email-code-daily:${shanghaiDay()}`;
  if ((rates.get(budgetKey)?.count ?? 0) >= Number(env.EMAIL_DAILY_MAX ?? 100)) {
    console.error('email_code_budget_exhausted', JSON.stringify({}));
    fail(429, 'email_budget_exhausted');
  }
  const code = String(Number(BigInt(`0x${randomBytes(4).toString('hex')}`) % 1000000n)).padStart(6, '0');
  // One active code per mailbox: a resend invalidates the previous code.
  emailCodes.set(email, { codeHash: digest(`${email}:${code}`), expiresAt: Date.now() + 900000, attempts: 0 });
  try { await mailer.sendVerificationCode(email, code, 15); }
  catch (error) {
    emailCodes.delete(email);
    console.error('email_send_failed', JSON.stringify({ stage: 'smtp' }));
    fail(503, 'email_unavailable');
  }
  chargeEmailCodeBudget();
  console.error('email_code_sent', JSON.stringify({ masked: `${email.slice(0, 2)}***${email.slice(email.indexOf('@'))}` }));
  return send(response, 200, { sent: true, expiresIn: 900 });
}

async function emailAuthRoute(request, response, ip, path) {
  rate(`auth:${ip}`, Number(env.AUTH_RATE_MAX ?? 10), 60000);
  const body = await readJson(request);
  const { email, password } = credentials(body);
  rate(`email:${email}`, Number(env.EMAIL_RATE_MAX ?? 10), 60000);
  if (path.endsWith('/register')) {
    if (!mailer) fail(503, 'email_unavailable');
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    consumeEmailCode(email, code);
    if (activePasswords >= 4) fail(429, 'rate_limited');
    activePasswords++;
    try { return send(response, 201, { account: await register(email, password) }); }
    finally { activePasswords--; }
  }
  if (activePasswords >= 4) fail(429, 'rate_limited');
  activePasswords++;
  try {
    const row = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
    const valid = await verifyPassword(password, row?.password_hash ?? dummyPassword);
    if (!row || row.disabled || !valid) fail(401, 'invalid_credentials');
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (id, account_id, token_digest, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id('ses'), row.id, digest(token), now(), now());
    return send(response, 200, { sessionToken: token, account: accountView(row), entitlement: entitlement(row.id) });
  } finally { activePasswords--; }
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
async function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${(await derive(password, salt, 32)).toString('hex')}`; }
async function verifyPassword(password, encoded) { try { const [, salt, expected] = encoded.split(':'); return timingSafeEqual(await derive(password, salt, 32), Buffer.from(expected, 'hex')); } catch { return false; } }
function consumeEmailCode(email, code) {
  const record = emailCodes.get(email);
  if (!record || record.expiresAt < Date.now()) {
    emailCodes.delete(email);
    fail(400, 'email_code_expired');
  }
  if (record.attempts >= 5) {
    emailCodes.delete(email);
    fail(400, 'email_code_expired');
  }
  record.attempts += 1;
  if (record.codeHash !== digest(`${email}:${code}`)) fail(400, 'invalid_email_code');
  emailCodes.delete(email);
}

function authenticate(request) {
  const token = request.headers.authorization;
  if (!token?.startsWith('Bearer ') || token.length > 256) return null;
  // a.created_at 别名为 account_created_at，避免与 sessions.created_at 重名
  const row = db.prepare('SELECT s.*, a.email, a.display_name, a.created_at AS account_created_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_digest = ? AND s.revoked_at IS NULL AND a.disabled = 0').get(digest(token.slice(7)));
  return row ? { id: row.id, account: { id: row.account_id, email: row.email, display_name: row.display_name, createdAt: row.account_created_at } } : null;
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
function accountView(row) { return { accountId: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at ?? row.account_created_at ?? row.createdAt }; }
function orderView(row) { return { orderId: row.id, plan: row.plan, amountCny: row.amount_cny, currency: row.currency, status: row.status, createdAt: row.created_at }; }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
class SafeError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function fail(status, code) { throw new SafeError(status, code); }
function send(response, status, body, extraHeaders) { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }); response.end(body === null ? '' : `${JSON.stringify(body)}\n`); }
async function boundedText(stream, limit) { const chunks = []; let size = 0; for await (const chunk of stream) { size += chunk.length; if (size > limit) fail(413, 'request_too_large'); chunks.push(chunk); } return Buffer.concat(chunks).toString('utf8'); }
async function readJson(request, limit = 64 * 1024) { if (Number(request.headers['content-length'] ?? 0) > limit) fail(413, 'request_too_large'); if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'json_required'); const text = await boundedText(request, limit); let result; try { result = JSON.parse(text); } catch { fail(400, 'invalid_json'); } if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'invalid_json'); return result; }
function requestId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) fail(400, 'invalid_request_id'); return value; }
function rate(key, max, window) { const old = rates.get(key); const value = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + window }; if (++value.count > max) fail(429, 'rate_limited'); if (rates.size >= 20000 && !rates.has(key)) fail(429, 'rate_limited'); rates.set(key, value); }
function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${randomBytes(12).toString('hex')}`; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function loadEnv() { const values = { ...process.env }; try { for (const line of readFileSync('.env', 'utf8').split(/\r?\n/u)) { const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/u); if (match && values[match[1]] === undefined) values[match[1]] = match[2].replace(/^['"]|['"]$/gu, ''); } } catch {} return values; }
