import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { prompts } from './prompts.js';

process.umask(0o077);
const env = loadEnv();
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new Error('A strong ADMIN_TOKEN is required');
if (env.MODEL_BASE_URL) {
  const url = new URL(env.MODEL_BASE_URL);
  if (url.protocol !== 'https:' && !(env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Model endpoint must use HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid model endpoint');
}
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
  CREATE INDEX IF NOT EXISTS license_account ON licenses(account_id, revision);
  CREATE INDEX IF NOT EXISTS usage_account_date ON ai_usage(account_id, created_at);
`);
const rates = new Map();
let activePasswords = 0;
const derive = promisify(scrypt);
const dummyPassword = await hashPassword(randomBytes(32).toString('hex'));
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
  try { await route(request, response); }
  catch (error) { send(response, error instanceof SafeError ? error.status : 500, { code: error instanceof SafeError ? error.code : 'internal_error' }); }
});
server.listen(Number(env.PORT ?? 8780), env.HOST ?? '127.0.0.1', () => console.log('MetaWork official service ready'));
const retention = setInterval(() => {
  db.prepare("DELETE FROM ai_usage WHERE created_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  db.prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
  for (const [key, value] of rates) if (value.until < Date.now()) rates.delete(key);
}, 60000);
retention.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(retention); server.close(() => { db.close(); process.exit(0); }); });

async function route(request, response) {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/healthz') return send(response, 200, { ok: true });
  if (path.startsWith('/v1/admin/')) return adminRoute(request, response, path);
  const ip = request.socket.remoteAddress === '127.0.0.1' && env.TRUST_PROXY === '1'
    ? String(request.headers['x-real-ip'] ?? request.socket.remoteAddress) : request.socket.remoteAddress;
  if (path !== '/v1/ai/operation') rate(`http:${ip}`, 120, 60000);
  if (request.method === 'POST' && ['/v1/auth/login', '/v1/auth/register'].includes(path)) {
    rate(`auth:${ip}`, 10, 60000);
    const body = await readJson(request);
    const { email, password } = credentials(body);
    rate(`email:${email}`, 10, 60000);
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
    rate(`orders:${session.account.id}`, 10, 60000);
    const body = await readJson(request);
    const selected = publicPlans().find(plan => plan.plan === body.plan);
    if (!selected) fail(400, 'invalid_plan');
    const key = `${session.account.id}:${requestId(body.idempotencyKey)}`;
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
  if (path === '/v1/admin/accounts') {
    const { email, password } = credentials(body);
    return send(response, 201, { account: await register(email, password) });
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
  db.prepare('INSERT INTO licenses (id, account_id, plan, status, effective_at, expires_at, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id('lic'), accountId, plan, status, now(), expiresAt, revision, now());
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
