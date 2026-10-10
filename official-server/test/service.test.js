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
import { addCalendarMonths } from '../business.js';

let child, root, db, base, upstream;
let tokenA, tokenB, accountA, upstreamCalls = 0, upstreamBody, release, held;
let upstreamResult, upstreamStatus = 200, upstreamFinishReason = 'stop', diagnostics = '';
const admin = 'test-admin-token-'.repeat(4);
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
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(root, 'test.sqlite'), ADMIN_TOKEN: admin, MODEL_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MODEL_API_KEY: 'test-private-key', MODEL_ID: 'private-model', MODEL_THINKING: 'ignored-legacy-setting', AI_DAILY_GLOBAL_LIMIT: 'ignored-legacy-setting', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => child.once('exit', () => reject(new Error('Service exited'))))]);
  db = new DatabaseSync(join(root, 'test.sqlite'));
});
after(async () => { if (child) { child.kill(); await once(child, 'exit'); } db?.close(); await new Promise(resolve => upstream?.close(resolve)); await rm(root, { recursive: true, force: true }); });

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
