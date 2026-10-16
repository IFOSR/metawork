// Manual full-chain smoke against the real OPC Hub gateway. Never runs in CI.
// Credentials come from the environment only: PAYMENT_HUB_BASE_URL, PAYMENT_HUB_CLIENT_ID,
// PAYMENT_HUB_CLIENT_SECRET, optional PAYMENT_NOTIFY_URL. Creates real gateway orders that
// stay unpaid and expire after 30 minutes; no refund is attempted because no money moves.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';
import { createHubClient, signHubRequest } from '../hub-payments.js';

const env = process.env;
for (const key of ['PAYMENT_HUB_BASE_URL', 'PAYMENT_HUB_CLIENT_ID', 'PAYMENT_HUB_CLIENT_SECRET']) {
  if (!env[key]) { console.error(`FAIL bootstrap missing env ${key}`); process.exit(1); }
}
const hub = createHubClient({
  baseUrl: env.PAYMENT_HUB_BASE_URL,
  clientId: env.PAYMENT_HUB_CLIENT_ID,
  clientSecret: env.PAYMENT_HUB_CLIENT_SECRET,
  notifyUrl: env.PAYMENT_NOTIFY_URL || undefined,
});
const step = async (name, fn) => {
  try {
    const result = await fn();
    console.log(`PASS ${name} ${typeof result === 'string' ? result : JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.log(`FAIL ${name} ${JSON.stringify({ status: error.status, code: error.code, requestId: error.requestId, message: error.message })}`);
    process.exitCode = 1;
    return null;
  }
};
const timestamp = () => new Date().toISOString();

console.log(`# real hub smoke ${timestamp()} base=${env.PAYMENT_HUB_BASE_URL}`);

// --- Section A: direct gateway lifecycle ---
const created = await step('A1 create-order', () => hub.createHubOrder({
  amountCents: 990,
  description: `MetaWork 支付通道真实链路测试 ${timestamp()}`,
  notifyUrl: env.PAYMENT_NOTIFY_URL || undefined,
  expireMinutes: 30,
  idempotencyKey: `smoke-create-${Date.now()}`,
}));
if (!created?.order_no) { console.log('# stopping: no gateway order'); process.exitCode = 1; } else {
const orderNo = created.order_no;

await step('A2 prepay', async () => {
  const order = await hub.prepayHubOrder(orderNo, `smoke-prepay-${orderNo}`);
  return { status: order.status, qr: order.qr_code_url, expire_time: order.expire_time };
});
await step('A3 query-unpaid', async () => {
  const order = await hub.queryHubOrder(orderNo);
  return { status: order.status, amount_cents: order.amount_cents, currency: order.currency, refunded_amount_cents: order.refunded_amount_cents };
});
await step('A4 close-order', () => hub.closeHubOrder(orderNo, `smoke-close-${orderNo}`));
await step('A5 query-after-close', async () => {
  const order = await hub.queryHubOrder(orderNo);
  return { status: order.status };
});
await step('A6 query-unknown-order', async () => {
  try {
    await hub.queryHubOrder('0'.repeat(32));
    return 'unexpected-success';
  } catch (error) {
    return { status: error.status, code: error.code };
  }
});
}

// --- Section B: local official service end-to-end against the real gateway ---
const root = mkdtempSync(join(tmpdir(), 'metawork-hub-smoke-'));
const adminToken = randomBytes(24).toString('hex');
const port = await new Promise(resolve => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); probe.once('listening', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  cwd: root,
  env: {
    ...env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'smoke.sqlite'),
    ADMIN_TOKEN: adminToken,
    PAYMENT_HUB_BASE_URL: env.PAYMENT_HUB_BASE_URL, PAYMENT_HUB_CLIENT_ID: env.PAYMENT_HUB_CLIENT_ID,
    PAYMENT_HUB_CLIENT_SECRET: env.PAYMENT_HUB_CLIENT_SECRET, PAYMENT_NOTIFY_URL: env.PAYMENT_NOTIFY_URL || '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childStderr = '';
child.stderr.on('data', chunk => { childStderr += chunk.toString(); });
await once(child.stdout, 'data');
const base = `http://127.0.0.1:${port}`;
const call = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
try {
  await call('/v1/auth/register', { method: 'POST', body: { email: 'hub-smoke@example.com', password: 'smoke-password-12345' } });
  const login = await call('/v1/auth/login', { method: 'POST', body: { email: 'hub-smoke@example.com', password: 'smoke-password-12345' } });
  const token = login.body.sessionToken;
  const order = await call('/v1/orders', { method: 'POST', token, body: { plan: 'monthly', idempotencyKey: `smoke-order-${Date.now()}` } });
  const orderId = order.body.orderId;
  const pay = await step('B1 server-pay-real-qr', () => call(`/v1/orders/${orderId}/pay`, { method: 'POST', token, body: {} }));
  const payHubNo = pay?.body?.payment?.hubOrderNo;
  await step('B2 server-reconcile-pending', async () => {
    const view = await call(`/v1/orders/${orderId}`, { token });
    return { order: view.body?.order?.status, payment: view.body?.payment?.status, qr: Boolean(view.body?.payment?.qrCodeUrl) };
  });
  await step('B3 notify-forged-signature-401', async () => {
    const raw = JSON.stringify({ event_type: 'PAYMENT.PAID', order_no: payHubNo, amount_cents: 990, paid_time: new Date().toISOString(), paid_time_epoch: Math.floor(Date.now() / 1000) });
    const response = await fetch(`${base}/v1/payments/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': env.PAYMENT_HUB_CLIENT_ID, 'X-Timestamp': String(Date.now()), 'X-Nonce': randomBytes(8).toString('hex'), 'X-Signature': 'ab'.repeat(32) }, body: raw });
    return { status: response.status };
  });
  await step('B4 notify-real-secret-unknown-order', async () => {
    const unknown = randomBytes(16).toString('hex');
    const raw = JSON.stringify({ event_type: 'PAYMENT.PAID', order_no: unknown, amount_cents: 990, paid_time: new Date().toISOString(), paid_time_epoch: Math.floor(Date.now() / 1000) });
    const path = '/v1/payments/notify';
    const ts = String(Date.now());
    const nonce = randomBytes(8).toString('hex');
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': env.PAYMENT_HUB_CLIENT_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': signHubRequest({ method: 'POST', path, query: '', body: raw, timestamp: ts, nonce, clientId: env.PAYMENT_HUB_CLIENT_ID, clientSecret: env.PAYMENT_HUB_CLIENT_SECRET }) }, body: raw });
    return { status: response.status };
  });
  await step('B5 admin-close-real-order', () => call('/v1/admin/orders/close', { method: 'POST', token: adminToken, body: { orderId } }));
  await step('B6 server-view-after-close', async () => {
    const view = await call(`/v1/orders/${orderId}`, { token });
    return { order: view.body?.order?.status, payment: view.body?.payment?.status };
  });
  await step('B7 pay-after-close-409', () => call(`/v1/orders/${orderId}/pay`, { method: 'POST', token, body: {} }));
} finally {
  child.kill();
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  rmSync(root, { recursive: true, force: true });
}
console.log(`# done ${timestamp()}${process.exitCode ? ' (with failures)' : ''}`);
