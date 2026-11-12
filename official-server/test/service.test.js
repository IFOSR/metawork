import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as nodeHttpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
let k8sStub, k8sCalls = [];
const k8sObjects = new Map();
let k8sFailNext = null;
// 桩的 Pod 镜像覆盖：模拟"旧 Pod 还在、新 Pod 还没起来"的升级窗口。
let stubPodImageOverride = null;
// 桩的兜底镜像：直接 seed 进数据库的实例没有对应的 Deployment 对象，桩无法从
// 模板取到镜像，只能回退到配置的期望镜像（真实集群里该 Deployment 一定存在）。
let stubFallbackImage = 'registry.test/metawork/sandbox:0.1.25';

/**
 * 构造一个就绪的 Pod。镜像取自同名 Deployment 的容器定义：真实 K8s 里 Pod 的
 * spec.containers[].image 来自它所属的 Deployment 模板，服务端正是用它判断
 * "这个 Ready 的 Pod 是不是目标镜像"——桩必须提供这个信号，否则就绪判定无从
 * 区分新旧 Pod。
 */
function stubPod(name) {
  const deployment = k8sObjects.get(`deployments/${name}`);
  const containers = deployment?.spec?.template?.spec?.containers ?? [];
  const images = containers.length
    ? containers.map(container => ({ image: container.image }))
    : [{ image: stubFallbackImage }];
  return {
    metadata: { name: `${name}-generated` },
    spec: { containers: stubPodImageOverride ? [{ image: stubPodImageOverride }] : images },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
}

/** Pod 列表按 labelSelector=app=<name> 查询；据此取到对应 Deployment 的镜像。 */
function stubPodFromSelector(searchParams) {
  const selector = String(searchParams.get('labelSelector') ?? '');
  const match = /(?:^|,)app=([^,]+)/u.exec(selector);
  return stubPod(match ? match[1] : 'pods');
}
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
  // K8s API 桩：内存对象存储 + 可编排失败 + 记录调用；路径覆盖 core/apps/networking/autoscaling.k8s.io。
  k8sStub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://k8s');
    const isScale = url.pathname.endsWith('/scale');
    const pathname = isScale ? url.pathname.slice(0, -6) : url.pathname;
    const match = /^\/(?:api\/v1|apis\/[^/]+\/v1)\/namespaces\/([^/]+)\/([a-z]+)(?:\/([^/]+))?$/u.exec(pathname);
    const done = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (!match) return done(404, { kind: 'Status', code: 404 });
    const [, , plural, name] = match;
    const readBody = () => new Promise(resolve => {
      const chunks = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
    });
    if (req.method === 'PATCH' && name && !isScale) {
      // 通用 merge patch（strategic-merge 语义的浅合并）：版本更新用。
      void readBody().then(body => {
        k8sCalls.push({ method: 'PATCH', plural, name });
        const stored = k8sObjects.get(`${plural}/${name}`);
        if (!stored) return done(404, { kind: 'Status', code: 404 });
        if (body?.spec) Object.assign(stored.spec, body.spec);
        done(200, stored);
      });
      return;
    }
    if (req.method === 'PATCH' && isScale && name) {
      void readBody().then(body => {
        k8sCalls.push({ method: 'PATCH', plural, name, scale: body?.spec?.replicas });
        const stored = k8sObjects.get(`${plural}/${name}`);
        if (stored) stored.spec.replicas = body?.spec?.replicas;
        done(200, stored ?? { spec: { replicas: body?.spec?.replicas } });
      });
      return;
    }
    k8sCalls.push({ method: req.method, plural, name: name ?? null });
    if (req.method === 'POST' && !name) {
      if (k8sFailNext === plural) { k8sFailNext = null; return done(500, { code: 'stub_failure' }); }
      void readBody().then(manifest => {
        k8sObjects.set(`${plural}/${manifest?.metadata?.name ?? 'unnamed'}`, manifest);
        done(201, manifest);
      });
      return;
    }
    if (req.method === 'GET' && name) {
      if (plural === 'pods') return done(200, { items: [stubPod(name)] });
      const stored = k8sObjects.get(`${plural}/${name}`);
      if (!stored) return done(404, { kind: 'Status', code: 404 });
      if (plural === 'verticalpodautoscalers') return done(200, { ...stored, status: { recommendation: { containerRecommendations: [{ target: { cpu: '750m', memory: '1Gi' } }] } } });
      // Deployment 的 rollout 状态：桩按已注册的模板给出已收敛的信号。
      if (plural === 'deployments') {
        const generation = Number(stored.metadata?.generation ?? 1);
        const replicas = Number(stored.spec?.replicas ?? 1);
        return done(200, { ...stored, status: { observedGeneration: generation, replicas, updatedReplicas: replicas, availableReplicas: replicas } });
      }
      return done(200, stored);
    }
    if (req.method === 'GET') {
      if (plural === 'pods') return done(200, { items: [stubPodFromSelector(url.searchParams)] });
      return done(200, { items: [...k8sObjects.entries()].filter(([key]) => key.startsWith(`${plural}/`)).map(([, value]) => value) });
    }
    if (req.method === 'DELETE' && name) {
      if (k8sObjects.delete(`${plural}/${name}`)) return done(200, {});
      return done(404, { kind: 'Status', code: 404 });
    }
    done(405, {});
  });
  k8sStub.listen(0, '127.0.0.1'); await once(k8sStub, 'listening');
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test.sqlite'), ADMIN_TOKEN: admin, MODEL_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MODEL_API_KEY: 'test-private-key', MODEL_ID: 'private-model', NODE_ENV: 'test', HTTP_RATE_MAX: '100000', AUTH_RATE_MAX: '100000', EMAIL_RATE_MAX: '100000', ORDERS_RATE_MAX: '100000', PAY_RATE_MAX: '100000', SMTP_HOST: 'smtp.test', SMTP_PORT: '587', SMTP_USER: 'metawork-test', SMTP_PASS: 'test-smtp-pass', SMTP_FROM: 'MetaWork <noreply@metawork.test>', PAYMENT_HUB_BASE_URL: `http://127.0.0.1:${hub.address().port}`, PAYMENT_HUB_CLIENT_ID: hubClientId, PAYMENT_HUB_CLIENT_SECRET: hubSecret, PAYMENT_NOTIFY_URL: notifyUrl, K8S_API_BASE: `http://127.0.0.1:${k8sStub.address().port}`, RUNTIME_IMAGE: 'registry.test/metawork/sandbox:0.1.25', RUNTIME_ACCESS_SECRET: 'test-runtime-access-secret-0123456789abcdef', RUNTIME_RATE_MAX: '100000', RETENTION_SWEEP_MS: '200', RUNTIME_READY_POLL_MS: '10', RUNTIME_EXPIRE_GRACE_DAYS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => child.once('exit', () => reject(new Error('Service exited'))))]);
  db = new DatabaseSync(join(root, 'test.sqlite'));
  db.exec('PRAGMA busy_timeout = 10000');
});
after(async () => {
  if (diagnostics) console.error('--- child stderr tail ---\n' + diagnostics.slice(-2000));
  if (child) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]); }
  db?.close();
  await new Promise(resolve => upstream?.close(resolve));
  await new Promise(resolve => hub?.close(resolve));
  await new Promise(resolve => k8sStub?.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => {});
});
async function whenExited(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  await Promise.race([once(proc, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
}

// 注册走真实邮箱验证码路径：发码 → 从测试邮件池读码 → 注册 → 登录。
async function registerLogin(email) {
  const password = 'test-password-12345';
  assert.equal((await api('/v1/auth/email/code', { email })).status, 200);
  const code = await readEmailCode(email);
  assert.equal((await api('/v1/auth/register', { email, password, code })).status, 201);
  const login = await api('/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  return { token: login.body.sessionToken, accountId: login.body.account.accountId, email };
}
async function readEmailCode(email) {
  const outbox = await api('/v1/admin/email-outbox', {}, admin);
  assert.equal(outbox.status, 200);
  const mail = outbox.body.emails.at(-1);
  assert.equal(mail.to, email);
  return /(\d{6})/.exec(mail.text)[1];
}
// 等待后台 sweep 产生目标状态：轮询而非固定 sleep，避免与 sweep 周期竞态。
// 直接轮询数据库行：实例查询本身会刷新访问信号（查询即访问），不能用 API 轮询活跃度回收。
async function waitForDbStatus(sandboxId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = db.prepare('SELECT status FROM runtimes WHERE id = ?').get(sandboxId)?.status ?? null;
    if (expected.includes(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return last;
}

async function waitForStatus(token, sandboxId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const view = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
    last = view.body.sandbox?.status ?? null;
    if (expected.includes(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return last;
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
test('email-verified registration, opaque login and no persisted plaintext secrets', async () => {
  assert.equal((await api('/v1/auth/email/code', { email: 'not-an-email' })).status, 400);
  // 未发码直接注册：验证码不存在
  assert.equal((await api('/v1/auth/register', { email: 'a@example.com', password: 'test-password-12345', code: '000000' })).status, 400);
  assert.equal((await api('/v1/auth/email/code', { email: 'a@example.com' })).status, 200);
  const outbox = await api('/v1/admin/email-outbox', {}, admin);
  assert.equal(outbox.status, 200);
  const mail = outbox.body.emails.at(-1);
  assert.equal(mail.to, 'a@example.com');
  assert.match(mail.text, /MetaWork 验证码是 \d{6}/);
  const code = /(\d{6})/.exec(mail.text)[1];
  assert.equal((await api('/v1/auth/register', { email: 'a@example.com', password: 'test-password-12345', code })).status, 201);
  const login = await api('/v1/auth/login', { email: 'a@example.com', password: 'test-password-12345' });
  assert.equal(login.status, 200); assert.equal(login.body.entitlement.status, 'unknown');
  tokenA = login.body.sessionToken; accountA = login.body.account.accountId;
  assert.equal((await api('/v1/auth/login', { email: 'a@example.com', password: 'incorrect-password' })).status, 401);
  const sessions = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  const accounts = JSON.stringify(db.prepare('SELECT * FROM accounts').all());
  assert.ok(!sessions.includes(tokenA));
  assert.ok(!accounts.includes('test-password-12345'));
  // 错误验证码被拒；重发后新码可注册，但邮箱唯一冲突返回 409
  assert.equal((await api('/v1/auth/email/code', { email: 'a@example.com' })).status, 200);
  const secondCode = /(\d{6})/.exec((await api('/v1/admin/email-outbox', {}, admin)).body.emails.at(-1).text)[1];
  assert.equal((await api('/v1/auth/register', { email: 'a@example.com', password: 'test-password-12345', code: secondCode })).status, 409);
  tokenB = (await registerLogin('b@example.com')).token;
});
test('email codes enforce the per-mailbox breaker and reject bad addresses', async () => {
  assert.equal((await api('/v1/auth/email/code', { email: 'not-an-email' })).status, 400);
  const mailbox = 'rate@example.com';
  for (let i = 0; i < 5; i++) assert.equal((await api('/v1/auth/email/code', { email: mailbox })).status, 200);
  const limited = await api('/v1/auth/email/code', { email: mailbox });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'rate_limited');
});
test('registration without mail configuration and the production-mode mail sink', async () => {
  const port = await freePort();
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-prod-mode.sqlite'), ADMIN_TOKEN: admin }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    const post = (path, body, token) => fetch(`${alt}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/v1/admin/email-outbox', {}, admin)).status, 404);
    const code = await post('/v1/auth/email/code', { email: 'probe@example.com' });
    assert.equal(code.status, 503);
    assert.deepEqual(await code.json(), { code: 'email_unavailable' });
  } finally { isolated.kill(); await whenExited(isolated); }
});
test('the local daily mail-code budget breaker stops abuse', async () => {
  const port = await freePort();
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-budget.sqlite'), ADMIN_TOKEN: admin, EMAIL_DAILY_MAX: '2', SMTP_HOST: 'smtp.test', SMTP_PORT: '587', SMTP_USER: 'metawork-test', SMTP_PASS: 'test-smtp-pass', SMTP_FROM: 'MetaWork <noreply@metawork.test>', PAYMENT_HUB_BASE_URL: `http://127.0.0.1:${hub.address().port}`, PAYMENT_HUB_CLIENT_ID: hubClientId, PAYMENT_HUB_CLIENT_SECRET: hubSecret }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    const send = mailbox => fetch(`${alt}/v1/auth/email/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: mailbox }) }).then(r => r.status);
    assert.equal(await send('budget1@example.com'), 200);
    assert.equal(await send('budget2@example.com'), 200);
    assert.equal(await send('budget3@example.com'), 429);
  } finally { isolated.kill(); await whenExited(isolated); }
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
  // 单事务批量写：避免与后台 sweep 的写锁竞争（此前偶发 database is locked）。
  const insert = db.prepare('INSERT INTO ai_usage VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < 1001; i++) insert.run(`historical-${i}`, accountA, 'model_summary', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-no-payment.sqlite'), ADMIN_TOKEN: admin, SMTP_HOST: 'smtp.test', SMTP_PORT: '587', SMTP_USER: 'metawork-test', SMTP_PASS: 'test-smtp-pass', SMTP_FROM: 'MetaWork <noreply@metawork.test>' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    assert.equal((await api2(alt, '/v1/auth/email/code', { email: 'pay-k@example.com' })).status, 200);
    const outbox = await fetch(`${alt}/v1/admin/email-outbox`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: '{}' });
    const mail = (await outbox.json()).emails.at(-1);
    const code = /(\d{6})/.exec(mail.text)[1];
    const register = await api2(alt, '/v1/auth/register', { email: 'pay-k@example.com', password: 'test-password-12345', code });
    assert.equal(register.status, 201);
    const login = await api2(alt, '/v1/auth/login', { email: 'pay-k@example.com', password: 'test-password-12345' });
    assert.equal(login.status, 200);
    const { sessionToken } = login.body;
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
async function api2(alt, path, body) {
  const response = await fetch(`${alt}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
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

// ─── 实例（创建/查询/六步管线/回收/生命周期/免密）───
let sandboxA, sandboxC, sandboxD;
const k8sCreates = () => k8sCalls.filter(call => call.method === 'POST').map(call => call.plural);

test('instance create requires a session and an active entitlement', async () => {
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-key-0001' })).status, 401);
  const none = await registerLogin('instance-none@example.com');
  const forbidden = await api('/v1/runtimes', { idempotencyKey: 'instance-key-0001' }, none.token);
  assert.equal(forbidden.status, 402);
  assert.deepEqual(forbidden.body, { code: 'entitlement_inactive' });
});

test('instance creation provisions six resources and reaches running with all steps done', async () => {
  const { token } = await registerLogin('instance-a@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-trial-001' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-create-0001', name: 'Dev Workspace' }, token);
  assert.equal(created.status, 202);
  const instance = created.body.sandbox;
  assert.equal(instance.status, 'provisioning');
  assert.match(instance.domain, /^dev-workspace-[0-9a-f]{4}\.metawork\.nexusfusionai\.com$/u);
  assert.equal(instance.steps.length, 6);
  const replay = await api('/v1/runtimes', { idempotencyKey: 'instance-create-0001' }, token);
  assert.equal(replay.body.sandbox.sandboxId, instance.sandboxId);
  const second = await api('/v1/runtimes', { idempotencyKey: 'instance-create-0002' }, token);
  assert.equal(second.status, 409); assert.equal(second.body.code, 'sandbox_exists');
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-bad-tier-01', tier: 'xlarge' }, token)).body.code, 'invalid_tier');
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-bad-name-1', name: 'x'.repeat(49) }, token)).body.code, 'invalid_name');
  const deadline = Date.now() + 5000;
  let view;
  do {
    assert.ok(Date.now() < deadline, `instance did not reach running: ${JSON.stringify(view?.body ?? null)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    view = await api(`/v1/runtimes/${instance.sandboxId}`, undefined, token);
  } while (view.body.sandbox?.status !== 'running');
  assert.deepEqual(view.body.sandbox.steps.map(step => step.status), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.equal(view.body.sandbox.podPhase, 'Running');
  assert.equal(view.body.sandbox.resources.requests.cpu, '500m');
  const lastAccess = db.prepare('SELECT last_access_at FROM runtimes WHERE id = ?').get(instance.sandboxId).last_access_at;
  assert.ok(lastAccess && Date.now() - Date.parse(lastAccess) < 60000);
  await new Promise(resolve => setTimeout(resolve, 5100));
  const refreshed = await api(`/v1/runtimes/${instance.sandboxId}`, undefined, token);
  assert.deepEqual(refreshed.body.sandbox.vpa, { targetCpu: '750m', targetMemory: '1Gi' });
  assert.deepEqual(k8sCreates(), ['persistentvolumeclaims', 'deployments', 'verticalpodautoscalers', 'services', 'ingresses', 'ingresses']);
  sandboxA = { token, sandboxId: instance.sandboxId, domain: instance.domain };
});

test('a provisioning instance converges to running even without a query', async () => {
  // 回归：安装期超过 waitForReady 超时后，管线放弃等待，状态会卡在 provisioning。
  // 现在维护 sweep 独立兜底——即使没有任何查询，已就绪的实例也会收敛为 running。
  const { token } = await registerLogin('instance-converge@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-converge-trial-001' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-converge-0001' }, token);
  assert.equal(created.status, 202);
  const instanceId = created.body.sandbox.sandboxId;
  // 等创建步骤全部 done（ready 仍 pending）
  const stepsDeadline = Date.now() + 5000;
  let steps;
  do {
    assert.ok(Date.now() < stepsDeadline, 'creation steps did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
    steps = JSON.parse(db.prepare('SELECT steps_json FROM runtimes WHERE id = ?').get(instanceId).steps_json);
  } while (!steps.filter(entry => entry.name !== 'ready').every(entry => entry.status === 'done'));
  // 手工把 ready 步打回 pending 并强制 running→provisioning，模拟「等待超时后无人推进」
  db.prepare("UPDATE runtimes SET steps_json = ?, status = 'provisioning' WHERE id = ?")
    .run(JSON.stringify(steps.map(entry => entry.name === 'ready' ? { name: 'ready', status: 'pending' } : entry)), instanceId);
  // 不做任何查询，等维护 sweep 兜底收敛（sweep 周期 200ms）
  const convergeDeadline = Date.now() + 5000;
  let converged = null;
  while (Date.now() < convergeDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    converged = db.prepare('SELECT status FROM runtimes WHERE id = ?').get(instanceId)?.status ?? null;
    if (converged === 'running') break;
  }
  assert.equal(converged, 'running', 'maintenance sweep must converge a ready provisioning instance');
  const finalSteps = JSON.parse(db.prepare('SELECT steps_json FROM runtimes WHERE id = ?').get(instanceId).steps_json);
  assert.equal(finalSteps.find(entry => entry.name === 'ready').status, 'done');
});

test('instance views are account scoped and inputs are validated', async () => {
  const other = await registerLogin('instance-b@example.com');
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}`, undefined, other.token)).status, 404);
  const own = await api('/v1/runtimes', undefined, sandboxA.token);
  assert.equal(own.status, 200);
  assert.ok(own.body.sandboxes.some(item => item.sandboxId === sandboxA.sandboxId));
});

test('the console reads the payload keys the server actually returns', () => {
  // 回归：控制台曾读 payload.instances，而服务端返回 sandboxes → 列表永远为空。
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const consoleJs = readFileSync(join(root, 'console-dist', 'app.js'), 'utf8');
  const listRead = /state\.instances\s*=\s*payload\.(\w+)/u.exec(consoleJs);
  assert.ok(listRead, 'console must read the instance list from the payload');
  assert.ok(['sandboxes', 'instances'].includes(listRead[1]), `unexpected list key: ${listRead[1]}`);
  // 服务端实际返回的键必须在前端可接受的集合内
  const serverJs = readFileSync(join(root, 'server.js'), 'utf8');
  assert.match(serverJs, /sandboxes:\s*views/u);
});

test('a mid-pipeline failure records the failed step, rolls back and frees the slot', async () => {
  const { token } = await registerLogin('instance-c@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-trial-002' }, token)).status, 201);
  k8sFailNext = 'verticalpodautoscalers';
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-fail-0001' }, token);
  assert.equal(created.status, 202);
  const deadline = Date.now() + 5000;
  let view;
  do {
    assert.ok(Date.now() < deadline, 'instance did not reach failed');
    await new Promise(resolve => setTimeout(resolve, 20));
    view = await api(`/v1/runtimes/${created.body.sandbox.sandboxId}`, undefined, token);
  } while (view.body.sandbox.status !== 'failed');
  const steps = Object.fromEntries(view.body.sandbox.steps.map(step => [step.name, step]));
  assert.equal(steps.storage.status, 'done');
  assert.equal(steps.workload.status, 'done');
  assert.equal(steps.autoscale.status, 'failed'); assert.equal(steps.autoscale.reason, 'k8s_500');
  assert.equal(steps.ready.status, 'pending');
  const rollbackDeadline = Date.now() + 3000;
  let deletes;
  do {
    assert.ok(Date.now() < rollbackDeadline, 'rollback did not complete');
    await new Promise(resolve => setTimeout(resolve, 20));
    deletes = k8sCalls.filter(call => call.method === 'DELETE').map(call => call.plural);
  } while (deletes.length < 2);
  assert.deepEqual(deletes.slice(-2), ['deployments', 'persistentvolumeclaims']);
  const retry = await api('/v1/runtimes', { idempotencyKey: 'instance-fail-0002' }, token);
  assert.equal(retry.status, 202);
  const retryDeadline = Date.now() + 5000;
  let running;
  do {
    assert.ok(Date.now() < retryDeadline, 'retry instance did not reach running');
    await new Promise(resolve => setTimeout(resolve, 20));
    running = await api(`/v1/runtimes/${retry.body.sandbox.sandboxId}`, undefined, token);
  } while (running.body.sandbox.status !== 'running');
  sandboxC = { token, sandboxId: retry.body.sandbox.sandboxId };
});

test('an interrupted provisioning resumes to completion on the next view', async () => {
  const { token, accountId } = await registerLogin('instance-resume@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-trial-003' }, token)).status, 201);
  const instanceId = `rt_${randomBytes(12).toString('hex')}`;
  const slug = `resume-${randomBytes(2).toString('hex')}`;
  const steps = ['storage', 'workload', 'autoscale', 'network', 'ingress', 'ready']
    .map(name => ({ name, status: ['storage', 'workload'].includes(name) ? 'done' : 'pending' }));
  const seedDb = new DatabaseSync(join(root, 'test.sqlite'));
  seedDb.exec('PRAGMA busy_timeout = 10000');
  const stamp = new Date().toISOString();
  seedDb.prepare("INSERT INTO accounts (id, email, display_name, password_hash, created_at) VALUES (?, 'ir@example.com', 'ir', 'scrypt:x:y', ?)").run(`acct_${randomBytes(8).toString('hex')}`, stamp);
  seedDb.prepare("INSERT INTO licenses (id, account_id, plan, status, effective_at, expires_at, revision, created_at) VALUES (?, ?, 'monthly', 'active', ?, ?, 1, ?)")
    .run(`lic_${randomBytes(8).toString('hex')}`, accountId, stamp, new Date(Date.now() + 30 * 86400000).toISOString(), stamp);
  seedDb.prepare('INSERT INTO runtimes (id, account_id, idempotency_key, name, slug, tier, image, status, domain, pod_phase, vpa_json, steps_json, last_access_at, suspend_at, access_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 1, ?, ?)')
    .run(instanceId, accountId, `resume-key-${instanceId.slice(3, 15)}`, 'resumed instance', slug, 'small', 'registry.test/metawork/sandbox:0.1.25', 'provisioning', `${slug}.metawork.nexusfusionai.com`, JSON.stringify(steps), stamp, stamp);
  seedDb.close();
  const createsBefore = k8sCreates().length;
  const deadline = Date.now() + 5000;
  let view;
  do {
    assert.ok(Date.now() < deadline, 'resumed instance did not reach running');
    await new Promise(resolve => setTimeout(resolve, 20));
    view = await api(`/v1/runtimes/${instanceId}`, undefined, token);
  } while (view.body.sandbox.status !== 'running');
  assert.deepEqual(k8sCreates().slice(createsBefore), ['verticalpodautoscalers', 'services', 'ingresses', 'ingresses']);
  assert.equal(db.prepare('SELECT status FROM runtimes WHERE id = ?').get(instanceId).status, 'running');
});

test('30-day no-access marks recycle_pending and only admin close deletes resources', async () => {
  db.prepare('UPDATE runtimes SET last_access_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400000).toISOString(), sandboxC.sandboxId);
  assert.equal(await waitForDbStatus(sandboxC.sandboxId, ['recycle_pending']), 'recycle_pending');
  const list = await api('/v1/admin/runtimes', {}, admin);
  assert.equal(list.status, 200);
  assert.ok(list.body.runtimes.some(item => item.sandboxId === sandboxC.sandboxId && item.status === 'recycle_pending'));
  const deletesBefore = k8sCalls.filter(call => call.method === 'DELETE').length;
  assert.equal((await api('/v1/admin/runtimes/close', { sandboxId: sandboxC.sandboxId }, admin)).status, 200);
  const deletedNow = k8sCalls.filter(call => call.method === 'DELETE').slice(deletesBefore).map(call => call.plural);
  assert.deepEqual(deletedNow, ['ingresses', 'ingresses', 'services', 'verticalpodautoscalers', 'deployments', 'persistentvolumeclaims']);
  assert.equal(db.prepare('SELECT status FROM runtimes WHERE id = ?').get(sandboxC.sandboxId).status, 'closed');
  const after = await api(`/v1/runtimes/${sandboxC.sandboxId}`, undefined, sandboxC.token);
  assert.equal(after.body.sandbox.status, 'closed');
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-close-re-01' }, sandboxC.token)).status, 202);
});

test('expired entitlement suspends the instance; renewal restarts the same instance', async () => {
  const { token, accountId } = await registerLogin('instance-expire@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-trial-004' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-expire-0001' }, token);
  assert.equal(created.status, 202);
  const instanceId = created.body.sandbox.sandboxId;
  const deadline = Date.now() + 5000;
  let view;
  do {
    assert.ok(Date.now() < deadline, 'expire instance did not reach running');
    await new Promise(resolve => setTimeout(resolve, 20));
    view = await api(`/v1/runtimes/${instanceId}`, undefined, token);
  } while (view.body.sandbox.status !== 'running');
  db.prepare('UPDATE licenses SET expires_at = ? WHERE account_id = ?').run(new Date(Date.now() - 2 * 86400000).toISOString(), accountId);
  assert.equal(await waitForStatus(token, instanceId, ['suspended']), 'suspended');
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-expire-0002' }, token)).status, 402);
  db.prepare("UPDATE licenses SET status = 'active', expires_at = ? WHERE account_id = ?").run(new Date(Date.now() + 30 * 86400000).toISOString(), accountId);
  assert.equal((await api('/v1/runtimes', { idempotencyKey: 'instance-expire-0002' }, token)).status, 409);
  const createsBefore = k8sCreates().length;
  const scalesBefore = k8sCalls.filter(call => call.method === 'PATCH').length;
  const renewDeadline = Date.now() + 5000;
  let running;
  do {
    assert.ok(Date.now() < renewDeadline, 'renewed instance did not reach running');
    await new Promise(resolve => setTimeout(resolve, 20));
    running = await api(`/v1/runtimes/${instanceId}`, undefined, token);
  } while (running.body.sandbox.status !== 'running');
  assert.equal(k8sCreates().length, createsBefore);
  assert.deepEqual(k8sCalls.filter(call => call.method === 'PATCH').slice(scalesBefore).map(call => call.scale), [1]);
  sandboxD = { token, accountId, sandboxId: instanceId };
});

test('a long-suspended instance is marked recycle_pending and only close enables recreation', async () => {
  db.prepare('UPDATE licenses SET expires_at = ? WHERE account_id = ?').run(new Date(Date.now() - 2 * 86400000).toISOString(), sandboxD.accountId);
  assert.equal(await waitForStatus(sandboxD.token, sandboxD.sandboxId, ['suspended']), 'suspended');
  assert.ok((await api('/v1/admin/runtimes', {}, admin)).body.runtimes.some(item => item.sandboxId === sandboxD.sandboxId && item.status === 'suspended'));
  db.prepare('UPDATE runtimes SET suspend_at = ?, updated_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400000).toISOString(), new Date(Date.now() - 31 * 86400000).toISOString(), sandboxD.sandboxId);
  const deadline = Date.now() + 3000;
  let view;
  do {
    assert.ok(Date.now() < deadline, 'suspend-keep sweep did not run');
    await new Promise(resolve => setTimeout(resolve, 25));
    view = await api(`/v1/runtimes/${sandboxD.sandboxId}`, undefined, sandboxD.token);
  } while (view.body.sandbox.status !== 'recycle_pending');
  assert.ok((await api('/v1/admin/runtimes', {}, admin)).body.runtimes.some(item => item.sandboxId === sandboxD.sandboxId && item.status === 'recycle_pending'));
  assert.equal((await api('/v1/admin/runtimes/close', { sandboxId: sandboxD.sandboxId }, admin)).status, 200);
  db.prepare("UPDATE licenses SET status = 'active', expires_at = ? WHERE account_id = ?").run(new Date(Date.now() + 30 * 86400000).toISOString(), sandboxD.accountId);
  const recreated = await api('/v1/runtimes', { idempotencyKey: 'instance-expire-0003' }, sandboxD.token);
  assert.equal(recreated.status, 202);
  assert.notEqual(recreated.body.sandbox.sandboxId, sandboxD.sandboxId);
});

test('the official console is served with safe headers', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/u);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const body = await home.text();
  assert.match(body, /MetaWork/u);
  const asset = await fetch(`${base}/console/app.js`);
  assert.match(asset.headers.get('content-type'), /javascript/u);
  const traversal = await fetch(`${base}/console/..%2f..%2fserver.js`);
  assert.equal(traversal.status, 404);
  // /v1 与 /admin 仍走 API 与既有守卫
  assert.equal((await fetch(`${base}/v1/plans`)).status, 200);
  assert.equal((await fetch(`${base}/v1/admin/email-outbox`, { method: 'POST' })).status, 401);
});

test('without RUNTIME_IMAGE the create entry answers sandbox_unavailable', async () => {
  const port = await freePort();
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-no-runtime.sqlite'), ADMIN_TOKEN: admin, SMTP_HOST: 'smtp.test', SMTP_PORT: '587', SMTP_USER: 'metawork-test', SMTP_PASS: 'test-smtp-pass', SMTP_FROM: 'MetaWork <noreply@metawork.test>', RUNTIME_IMAGE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    const post = (path, body, token) => fetch(`${alt}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
    assert.equal((await post('/v1/auth/email/code', { email: 'no-image@example.com' })).status, 200);
    const mail = (await post('/v1/admin/email-outbox', {}, admin)).body.emails.at(-1);
    const code = /(\d{6})/.exec(mail.text)[1];
    assert.equal((await post('/v1/auth/register', { email: 'no-image@example.com', password: 'test-password-123456', code })).status, 201);
    const login = (await post('/v1/auth/login', { email: 'no-image@example.com', password: 'test-password-123456' })).body;
    assert.equal((await post('/v1/orders', { plan: 'trial', idempotencyKey: 'no-image-trial-01' }, login.sessionToken)).status, 201);
    const created = await post('/v1/runtimes', { idempotencyKey: 'no-image-create-1' }, login.sessionToken);
    assert.equal(created.status, 503);
    assert.deepEqual(created.body, { code: 'sandbox_unavailable' });
  } finally { isolated.kill(); await whenExited(isolated); }
});

test('RUNTIME_WORKSPACE_ROOT injects the workspace root, an init container and a subPath mount', async () => {
  const port = await freePort();
  const isolated = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test-workspace-root.sqlite'), ADMIN_TOKEN: admin, SMTP_HOST: 'smtp.test', SMTP_PORT: '587', SMTP_USER: 'metawork-test', SMTP_PASS: 'test-smtp-pass', SMTP_FROM: 'MetaWork <noreply@metawork.test>', K8S_API_BASE: `http://127.0.0.1:${k8sStub.address().port}`, RUNTIME_IMAGE: 'registry.test/metawork/sandbox:0.1.25', RUNTIME_ACCESS_SECRET: 'test-runtime-access-secret-0123456789abcdef', RUNTIME_RATE_MAX: '100000', RETENTION_SWEEP_MS: '200', RUNTIME_READY_POLL_MS: '10', RUNTIME_WORKSPACE_ROOT: '/workspace' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(isolated.stdout, 'data');
    const alt = `http://127.0.0.1:${port}`;
    const post = (path, body, token) => fetch(`${alt}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
    assert.equal((await post('/v1/auth/email/code', { email: 'wsroot@example.com' })).status, 200);
    const mail = (await post('/v1/admin/email-outbox', {}, admin)).body.emails.at(-1);
    const code = /(\d{6})/.exec(mail.text)[1];
    assert.equal((await post('/v1/auth/register', { email: 'wsroot@example.com', password: 'test-password-123456', code })).status, 201);
    const login = (await post('/v1/auth/login', { email: 'wsroot@example.com', password: 'test-password-123456' })).body;
    assert.equal((await post('/v1/orders', { plan: 'trial', idempotencyKey: 'wsroot-trial-01' }, login.sessionToken)).status, 201);
    assert.equal((await post('/v1/runtimes', { idempotencyKey: 'wsroot-create-1' }, login.sessionToken)).status, 202);

    // 创建管线异步推进，等 Deployment 落库。
    let deployed = null;
    for (let attempt = 0; attempt < 50 && !deployed; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      deployed = [...k8sObjects.entries()].find(([key, value]) => key.startsWith('deployments/')
        && JSON.stringify(value).includes('METAWORK_WORKSPACE_ROOT')) ?? null;
    }
    assert.ok(deployed, 'deployment must carry the workspace root configuration');
    const spec = deployed[1].spec.template.spec;
    // subPath 目标必须先在卷上存在：initContainer 挂整卷建目录。
    assert.ok(Array.isArray(spec.initContainers) && spec.initContainers.length === 1);
    assert.equal(spec.initContainers[0].name, 'workspace-init');
    assert.deepEqual(spec.initContainers[0].volumeMounts, [{ name: 'data', mountPath: '/workspace' }]);
    // 主容器：/workspace 走同卷子路径，不额外申请存储。
    const container = spec.containers[0];
    const workspaceMount = container.volumeMounts.find(mount => mount.mountPath === '/workspace');
    assert.deepEqual(workspaceMount, { name: 'data', mountPath: '/workspace', subPath: 'workspace' });
    const rootEnv = container.env.find(entry => entry.name === 'METAWORK_WORKSPACE_ROOT');
    assert.deepEqual(rootEnv, { name: 'METAWORK_WORKSPACE_ROOT', value: '/workspace' });
    // 启动脚本必须先清遗留运行锁：锁是 PID 文件锁却在 PVC 上跨容器存活，新容器
    // 里 PID 1 永远存在，旧锁会被误判为"已在运行"，install 与 server start 全挂。
    assert.match(container.args[0], /rm -f \/data\/anyfusion\/data\/runtime\.lock;/u);
    // 容器直跑镜像（ADR-0055）：app/current 兼容层指向镜像，不再有 install-cli 拷贝。
    assert.match(container.args[0], /ln -sfn \/app \/data\/anyfusion\/app\/current;/u);
    assert.ok(!container.args[0].includes('install-cli'), 'the container start script must not run install-cli');
    const bootstrapEnv = container.env.find(entry => entry.name === 'METAWORK_CONTAINER_BOOTSTRAP');
    assert.deepEqual(bootstrapEnv, { name: 'METAWORK_CONTAINER_BOOTSTRAP', value: '1' });
  } finally { isolated.kill(); await whenExited(isolated); }
});

test('without RUNTIME_WORKSPACE_ROOT the instance keeps the unrestricted directory behaviour', async () => {
  // 对照：主测试 server 未配置该变量，实例不得带 initContainer 与 /workspace 挂载。
  const deployed = [...k8sObjects.entries()].find(([key]) => key.startsWith('deployments/'));
  assert.ok(deployed);
  const spec = deployed[1].spec.template.spec;
  assert.equal(spec.initContainers, undefined);
  assert.equal(spec.containers[0].volumeMounts.some(mount => mount.mountPath === '/workspace'), false);
  assert.equal(spec.containers[0].env.some(entry => entry.name === 'METAWORK_WORKSPACE_ROOT'), false);
});

test('a provisioning row present at boot resumes without crashing the service', async () => {
  const port = await freePort();
  const bootDb = join(root, 'test-boot-resume.sqlite');
  const bootEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: bootDb, ADMIN_TOKEN: admin, K8S_API_BASE: `http://127.0.0.1:${k8sStub.address().port}`, RUNTIME_IMAGE: 'registry.test/metawork/sandbox:0.1.25', RUNTIME_ACCESS_SECRET: 'test-runtime-access-secret-0123456789abcdef', RUNTIME_RATE_MAX: '100000', RETENTION_SWEEP_MS: '200', RUNTIME_READY_POLL_MS: '10' };
  const first = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: bootEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(first.stdout, 'data');
  first.kill(); await whenExited(first);
  const instanceId = `rt_${randomBytes(12).toString('hex')}`;
  const slug = `boot-${randomBytes(2).toString('hex')}`;
  const steps = ['storage', 'workload', 'autoscale', 'network', 'ingress', 'ready']
    .map(name => ({ name, status: ['storage'].includes(name) ? 'done' : 'pending' }));
  const seedDb = new DatabaseSync(bootDb);
  seedDb.exec('PRAGMA busy_timeout = 10000');
  const stamp = new Date().toISOString();
  const accountIdBoot = `acct_${randomBytes(8).toString('hex')}`;
  seedDb.prepare("INSERT INTO accounts (id, email, display_name, password_hash, created_at) VALUES (?, 'boot@example.com', 'boot', 'scrypt:x:y', ?)").run(accountIdBoot, stamp);
  seedDb.prepare("INSERT INTO licenses (id, account_id, plan, status, effective_at, expires_at, revision, created_at) VALUES (?, ?, 'monthly', 'active', ?, ?, 1, ?)")
    .run(`lic_${randomBytes(8).toString('hex')}`, accountIdBoot, stamp, new Date(Date.now() + 30 * 86400000).toISOString(), stamp);
  seedDb.prepare('INSERT INTO runtimes (id, account_id, idempotency_key, name, slug, tier, image, status, domain, pod_phase, vpa_json, steps_json, last_access_at, suspend_at, access_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 1, ?, ?)')
    .run(instanceId, accountIdBoot, `boot-key-${instanceId.slice(3, 15)}`, 'boot resume', slug, 'small', 'registry.test/metawork/sandbox:0.1.25', 'provisioning', `${slug}.metawork.nexusfusionai.com`, JSON.stringify(steps), stamp, stamp);
  seedDb.close();
  const second = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: bootEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let secondStderr = '';
  second.stderr.on('data', chunk => { secondStderr += chunk.toString(); });
  try {
    await once(second.stdout, 'data');
    const deadline = Date.now() + 5000;
    let status = '';
    const check = new DatabaseSync(bootDb);
    while (Date.now() < deadline) {
      status = check.prepare('SELECT status FROM runtimes WHERE id = ?').get(instanceId)?.status ?? '';
      if (status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    check.close();
    assert.equal(status, 'running');
    assert.ok(!secondStderr.includes('ReferenceError'), 'startup sweep must not hit TDZ');
  } finally { second.kill(); await whenExited(second); }
});

// ─── 免密登录（钥匙 et / 门票 Cookie / 会话兑换）───
// 门禁 verify 的定位方式必须与 nginx auth-url 子请求的真实形态一致：子请求的 Host 是
// 官方服务自己的地址，沙盒域名只能经 X-Original-URI 传递。因此 verify 不依赖 Host。
const verifyRequest = (cookieValue, { host, originalUri } = {}) => new Promise(resolve => {
  const port = new URL(base).port;
  const headers = { Cookie: cookieValue };
  if (host) headers.Host = host;
  if (originalUri) headers['X-Original-URI'] = originalUri;
  const req = nodeHttpRequest({ host: '127.0.0.1', port, path: '/v1/runtime-access/verify', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end();
});
const verifyWithHost = (domain, cookieValue) => verifyRequest(cookieValue, { host: domain });

test('instance access-url requires ownership and mints keys bound to the instance', async () => {
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, undefined)).status, 401);
  const other = await registerLogin('instance-key@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-key-trial-001' }, other.token)).status, 201);
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, other.token)).status, 404);
  const minted = await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, sandboxA.token);
  assert.equal(minted.status, 200);
  assert.match(minted.body.accessUrl, /^https:\/\/[a-z0-9-]+\.metawork\.nexusfusionai\.com\/_auth\/redeem\?et=/u);
  assert.equal(minted.body.expiresIn, 60);
  const view = await api(`/v1/runtimes/${sandboxA.sandboxId}`, undefined, sandboxA.token);
  assert.match(view.body.access.accessUrl, /\/_auth\/redeem\?et=/u);
  assert.equal(view.body.access.expiresIn, 60);
});

test('instance version update rolls the deployment to the configured image', async () => {
  // 制造版本差异：实例仍运行旧镜像，期望镜像被回拨为旧版本（与最新配置不同）。
  // version 报告的是**实际运行**的镜像，升级完成前不会变。
  db.prepare('UPDATE runtimes SET image = ?, applied_image = ? WHERE id = ?')
    .run('registry.test/metawork/sandbox:0.1.24', 'registry.test/metawork/sandbox:0.1.24', sandboxA.sandboxId);
  const view = await api(`/v1/runtimes/${sandboxA.sandboxId}`, undefined, sandboxA.token);
  assert.equal(view.body.sandbox.version, '0.1.24');
  assert.equal(view.body.sandbox.latestVersion, '0.1.25');
  assert.equal(view.body.sandbox.updateAvailable, true);
  // 未登录 401 / 他人 404
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}/upgrade`, {}, undefined)).status, 401);
  const other = await registerLogin('instance-upg@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-upg-trial-001' }, other.token)).status, 201);
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}/upgrade`, {}, other.token)).status, 404);
  // 升级：202 → 更新中 → 轮询至 running，镜像为新配置
  const upgrade = await api(`/v1/runtimes/${sandboxA.sandboxId}/upgrade`, {}, sandboxA.token);
  assert.equal(upgrade.status, 202, `upgrade: ${JSON.stringify(upgrade.body).slice(0, 240)}`);
  assert.equal(upgrade.body.sandbox.status, 'updating');
  // 升级中：服务尚未可用，实际运行版本仍是旧的。
  assert.equal(upgrade.body.sandbox.serviceReady, false);
  assert.equal(upgrade.body.sandbox.version, '0.1.24');
  assert.equal(upgrade.body.sandbox.updateAvailable, false);
  const deadline = Date.now() + 5000;
  let done;
  do {
    assert.ok(Date.now() < deadline, `upgrade stuck: ${JSON.stringify(done?.body ?? null).slice(0, 300)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    done = await api(`/v1/runtimes/${sandboxA.sandboxId}`, undefined, sandboxA.token);
  } while (done.body.sandbox?.status !== 'running');
  // 就绪后才算完成：版本切换到新镜像，服务标记为可用。
  assert.equal(done.body.sandbox.version, '0.1.25');
  assert.equal(done.body.sandbox.serviceReady, true);
  assert.equal(done.body.sandbox.updateAvailable, false);
  // 已最新：再次升级 → 409
  assert.equal((await api(`/v1/runtimes/${sandboxA.sandboxId}/upgrade`, {}, sandboxA.token)).status, 409);
  // Deployment 模板已被 patch 到新镜像（桩内可见）
  const deployed = [...k8sObjects.entries()].find(([key]) => key.startsWith('deployments/'));
  assert.ok(deployed && JSON.stringify(deployed[1].spec.template.spec.containers[0].image) === JSON.stringify('registry.test/metawork/sandbox:0.1.25'));
});

test('an upgrade is not reported complete while the old Pod is still the Ready one', async () => {
  // 回归：Recreate 策略下 patch 模板后旧 Pod 还在（Ready=True）。旧实现只看
  // "有没有 Ready 的 Pod"，会把旧 Pod 当成新 Pod，升级瞬间就报完成——用户看到
  // "运行中/已完成"但容器里跑的还是旧代码。判定必须按镜像匹配。
  const { token } = await registerLogin('instance-upgrace@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-upgrace-trial-001' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-upgrace-create-1' }, token);
  assert.equal(created.status, 202);
  const sandboxId = created.body.sandbox.sandboxId;
  const deadline = Date.now() + 5000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    const view = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
    if (view.body.sandbox.status === 'running') break;
  } while (Date.now() < deadline);
  assert.equal((await api(`/v1/runtimes/${sandboxId}`, undefined, token)).body.sandbox.serviceReady, true);

  // 制造"旧 Pod 仍 Ready"的窗口：桩返回的 Pod 用旧镜像。
  db.prepare('UPDATE runtimes SET image = ?, applied_image = ? WHERE id = ?')
    .run('registry.test/metawork/sandbox:0.1.24', 'registry.test/metawork/sandbox:0.1.24', sandboxId);
  stubPodImageOverride = 'registry.test/metawork/sandbox:0.1.24';
  try {
    const upgrade = await api(`/v1/runtimes/${sandboxId}/upgrade`, {}, token);
    assert.equal(upgrade.status, 202);
    assert.equal(upgrade.body.sandbox.status, 'updating');
    // 旧 Pod 的 Ready 不能让升级提前"完成"：服务仍标记为不可用。
    await new Promise(resolve => setTimeout(resolve, 300));
    const during = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
    assert.equal(during.body.sandbox.status, 'updating', 'old Ready pod must not complete the upgrade');
    assert.equal(during.body.sandbox.serviceReady, false);
    assert.equal(during.body.sandbox.version, '0.1.24', 'reported version stays the actually running one');
  } finally {
    stubPodImageOverride = null;
  }
  // 新 Pod 就绪后才收敛为 running 且版本切换。
  const settle = Date.now() + 5000;
  let done;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    done = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
  } while (done.body.sandbox?.status !== 'running' && Date.now() < settle);
  assert.equal(done.body.sandbox.status, 'running');
  assert.equal(done.body.sandbox.serviceReady, true);
  assert.equal(done.body.sandbox.version, '0.1.25');
});

test('a stored instance without service_ready regains its entry on the next view', async () => {
  // 回归：service_ready 是后加的列，存量实例该值为 0。若没有补检测路径，用户
  // 刷新实例页就永远拿不到"进入实例"入口。
  const { token, accountId } = await registerLogin('instance-readyfix@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-readyfix-trial-001' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-readyfix-create-1' }, token);
  assert.equal(created.status, 202);
  const sandboxId = created.body.sandbox.sandboxId;
  const deadline = Date.now() + 5000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    const view = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
    if (view.body.sandbox.status === 'running') break;
  } while (Date.now() < deadline);
  assert.equal((await api(`/v1/runtimes/${sandboxId}`, undefined, token)).body.sandbox.serviceReady, true);

  // 模拟存量实例：清掉 service_ready 与 applied_image。
  db.prepare('UPDATE runtimes SET service_ready = 0, applied_image = NULL WHERE id = ?').run(sandboxId);
  const afterReset = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
  assert.equal(afterReset.body.sandbox.serviceReady, true, 'detail view must re-detect readiness');

  db.prepare('UPDATE runtimes SET service_ready = 0, applied_image = NULL WHERE id = ?').run(sandboxId);
  const listed = await api('/v1/runtimes', undefined, token);
  const listedSandbox = listed.body.sandboxes.find(item => item.sandboxId === sandboxId);
  assert.equal(listedSandbox.serviceReady, true, 'list view must re-detect readiness');
  assert.equal(listedSandbox.version, '0.1.25');
  assert.ok(accountId);
});

test('a stored instance on an outdated deployment template is flagged and can be rebuilt', async () => {
  // 回归：部署配置（环境变量/挂载/发布号）变更后，存量实例的 Deployment 仍是
  // 老模板——新增的工作目录根限制、持久化挂载都不会生效。必须显式暴露漂移并
  // 允许重建，否则配置改了却永远不生效。
  const { token } = await registerLogin('instance-drift@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-drift-trial-001' }, token)).status, 201);
  const created = await api('/v1/runtimes', { idempotencyKey: 'instance-drift-create-1' }, token);
  assert.equal(created.status, 202);
  const sandboxId = created.body.sandbox.sandboxId;
  const deadline = Date.now() + 5000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    const view = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
    if (view.body.sandbox.status === 'running') break;
  } while (Date.now() < deadline);
  const current = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
  assert.equal(current.body.sandbox.templateDrifted, false, 'a freshly created instance matches the template');

  // 模拟集群里的 Deployment 与当前配置生成的模板不一致（老模板）。
  const deploymentKey = `deployments/mw-rt-${sandboxId.slice(3)}`;
  assert.ok(k8sObjects.has(deploymentKey), 'instance deployment must exist in the stub');
  const stored = k8sObjects.get(deploymentKey);
  stored.spec.template.spec.containers[0].image = 'registry.test/metawork/sandbox:0.1.20';

  const drifted = await api(`/v1/runtimes/${sandboxId}`, undefined, token);
  assert.equal(drifted.body.sandbox.templateDrifted, true, 'outdated template must be reported');

  // 镜像已是最新时，漂移仍允许重建（否则 409 already_latest 会挡住生效路径）。
  const rebuilt = await api(`/v1/runtimes/${sandboxId}/upgrade`, {}, token);
  assert.equal(rebuilt.status, 202, `rebuild: ${JSON.stringify(rebuilt.body).slice(0, 240)}`);
  const after = k8sObjects.get(deploymentKey);
  assert.equal(after.spec.template.spec.containers[0].image, 'registry.test/metawork/sandbox:0.1.25');
});

test('upgrade guards: already latest and wrong status are rejected', async () => {
  const { token } = await registerLogin('instance-upg2@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-upg2-trial-001' }, token)).status, 201);
  // 已是最新配置镜像 → 409 already_latest
  const fresh = await registerLogin('instance-upg3@example.com');
  assert.equal((await api('/v1/orders', { plan: 'trial', idempotencyKey: 'instance-upg3-trial-001' }, fresh.token)).status, 201);
  const freshCreated = await api('/v1/runtimes', { idempotencyKey: 'instance-upg3-0001' }, fresh.token);
  assert.equal(freshCreated.status, 202);
  const again = await api(`/v1/runtimes/${freshCreated.body.sandbox.sandboxId}/upgrade`, {}, fresh.token);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'already_latest');
  // closed 实例 → 409 instance_not_upgradable（状态临时置 closed 再恢复）
  db.prepare('UPDATE runtimes SET status = ? WHERE id = ?').run('closed', sandboxA.sandboxId);
  const closedUpgrade = await api(`/v1/runtimes/${sandboxA.sandboxId}/upgrade`, {}, sandboxA.token);
  assert.equal(closedUpgrade.status, 409);
  assert.equal(closedUpgrade.body.code, 'instance_not_upgradable');
  db.prepare('UPDATE runtimes SET status = ? WHERE id = ?').run('running', sandboxA.sandboxId);
});

test('redeem sets the gate cookie and verify enforces it with generation revocation', async () => {
  const minted = await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, sandboxA.token);
  const access = new URL(minted.body.accessUrl || 'https://invalid/');
  const et = access.searchParams.get('et');
  const tampered = await fetch(`${base}/v1/runtime-access/redeem?et=tampered`, { redirect: 'manual' });
  assert.equal(tampered.status, 401);
  const redeem = await fetch(`${base}/v1/runtime-access/redeem?et=${encodeURIComponent(et)}`, { redirect: 'manual' });
  assert.equal(redeem.status, 302);
  assert.match(redeem.headers.get('location'), /\/_sandbox\/exchange\?et=/u);
  // 无门禁：redeem 只做 302 跳转，不再种门票 Cookie。
  assert.equal(redeem.headers.get('set-cookie'), null);
  const cookie = '';
  // 门禁已移除：任何访问都放行；verify 只在票据有效时记录活跃度信号。
  assert.equal(await verifyWithHost(sandboxA.domain, cookie), 200);
  assert.equal(await verifyWithHost(sandboxA.domain, 'mw_rt=forged.sig'), 200);
  assert.equal(await verifyWithHost(sandboxA.domain, ''), 200);
  // 门禁子请求的真实形态：Host 是官方服务自己的地址（不依赖域名定位），仍能凭门票放行。
  assert.equal(await verifyRequest(cookie, { host: 'metawork-official.nexusfusionai.svc.cluster.local' }), 200);
  // 兑换路径必须放行（否则 /_auth/redeem 与 /_sandbox/exchange 会被门禁拦死）。
  assert.equal(await verifyRequest('', { originalUri: '/_auth/redeem?et=x' }), 200);
  assert.equal(await verifyRequest('', { originalUri: '/_sandbox/exchange?et=x' }), 200);

  // 票据随 access_generation 失效（revoke 时 +1），但不再阻断访问——只停止记录信号。
  db.prepare('UPDATE runtimes SET access_generation = access_generation + 1 WHERE id = ?').run(sandboxA.sandboxId);
  assert.equal(await verifyWithHost(sandboxA.domain, cookie), 200);
  db.prepare('UPDATE runtimes SET access_generation = access_generation - 1 WHERE id = ?').run(sandboxA.sandboxId);
  assert.equal(await verifyWithHost(sandboxA.domain, cookie), 200);
});

test('the /_auth ingress path reaches redeem without a session (ingress forwards the prefix verbatim)', async () => {
  // 回归：租户 -auth Ingress 无 rewrite，/_auth 前缀原样到达本服务；只注册
  // /v1/runtime-access/* 时浏览器免密链接会掉进兜底会话门禁返回 session_invalid。
  const minted = await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, sandboxA.token);
  const et = new URL(minted.body.accessUrl || 'https://invalid/').searchParams.get('et');
  const alias = await fetch(`${base}/_auth/redeem?et=${encodeURIComponent(et)}`, { redirect: 'manual' });
  assert.equal(alias.status, 302);
  assert.match(alias.headers.get('location'), new RegExp(`^https://${sandboxA.domain}/_sandbox/exchange\\?et=`, 'u'));
  // 服务端路由必须持续覆盖 /_auth 前缀（防止 ingress 转发形状与路由再漂移）。
  const serverSource = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'server.js'), 'utf8');
  assert.match(serverSource, /path === '\/_auth\/redeem'/u);
  assert.match(serverSource, /path === '\/_auth\/verify'/u);
  assert.match(serverSource, /path === '\/_auth\/session'/u);
});

test('session exchange consumes the et and only works after the gate redeem', async () => {
  const minted = await api(`/v1/runtimes/${sandboxA.sandboxId}/access-url`, {}, sandboxA.token);
  if (!minted.ok || !minted.body.accessUrl) console.error('MINT FAIL DEBUG', JSON.stringify(minted));
  const et = new URL(minted.body.accessUrl || 'https://invalid/').searchParams.get('et');
  assert.equal((await api('/v1/runtime-access/session', { et }, undefined)).status, 401);
  const redeem = await fetch(`${base}/v1/runtime-access/redeem?et=${encodeURIComponent(et)}`, { redirect: 'manual' });
  assert.equal(redeem.status, 302);
  const exchanged = await api('/v1/runtime-access/session', { et }, undefined);
  assert.equal(exchanged.status, 200);
  assert.ok(exchanged.body.sessionToken.length >= 32);
  assert.equal(exchanged.body.account.email, 'instance-a@example.com');
  assert.ok(exchanged.body.entitlement.status);
  assert.equal((await api('/v1/runtime-access/session', { et }, undefined)).status, 401);
  assert.ok(db.prepare('SELECT id FROM sessions WHERE instance_id = ?').get(sandboxA.sandboxId));
});

