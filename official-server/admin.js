// Run only on the official host through SSH; the secret never appears in argv or output.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const env = { ...process.env };
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/u);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^['"]|['"]$/gu, '');
  }
} catch { /* no .env beside admin.js (e.g. k8s): configuration comes from the environment */ }
const [command, ...rest] = process.argv.slice(2);
const base = `http://127.0.0.1:${env.PORT ?? 8780}`;
const call = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Administration failed: HTTP ${response.status} ${value?.code ?? ''}`.trim());
  return value;
};
if (command === 'incidents') {
  const resolveIndex = rest.indexOf('--resolve');
  const db = new DatabaseSync(env.DATABASE_PATH ?? './data/official.sqlite', { readOnly: resolveIndex === -1 });
  if (resolveIndex === -1) {
    const rows = db.prepare('SELECT incident_id, kind, hub_order_no, order_id, detail, created_at FROM payment_incidents WHERE resolved = 0 ORDER BY created_at').all();
    db.close();
    console.log(rows.length ? JSON.stringify(rows, null, 2) : 'No unresolved payment incidents.');
  } else {
    const incidentId = rest[resolveIndex + 1];
    if (!incidentId) throw new Error('Usage: node admin.js incidents --resolve <incident-id>');
    db.prepare("UPDATE payment_incidents SET resolved = 1, updated_at = ? WHERE incident_id = ? AND resolved = 0").run(new Date().toISOString(), incidentId);
    db.close();
    console.log(`Incident ${incidentId} resolved.`);
  }
} else if (command === 'orders') {
  const [email] = rest;
  if (!email) throw new Error('Usage: node admin.js orders <registered-email>');
  const db = new DatabaseSync(env.DATABASE_PATH ?? './data/official.sqlite', { readOnly: true });
  const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim().toLowerCase());
  db.close();
  if (!account) throw new Error('Account not found: register from MetaWork first');
  console.log(JSON.stringify(await call('/v1/admin/orders', { email: email.trim().toLowerCase() }), null, 2));
} else if (command === 'refund') {
  const [orderId, second, ...reasonWords] = rest;
  const hubOrderNo = second && /^[0-9a-f]{32}$/u.test(second) ? second : null;
  const reason = (hubOrderNo ? reasonWords : [second, ...reasonWords].filter(Boolean)).join(' ');
  if (!orderId || !reason) throw new Error('Usage: node admin.js refund <order-id> [hub-order-no] <reason>');
  console.log(JSON.stringify(await call('/v1/admin/refunds', { orderId, ...(hubOrderNo ? { hubOrderNo } : {}), reason }), null, 2));
} else if (command === 'refund-status') {
  const [refundNo] = rest;
  if (!refundNo) throw new Error('Usage: node admin.js refund-status <refund-no>');
  console.log(JSON.stringify(await call('/v1/admin/refunds/query', { refundNo }), null, 2));
} else if (command === 'close-order') {
  const [orderId] = rest;
  if (!orderId) throw new Error('Usage: node admin.js close-order <order-id>');
  console.log(JSON.stringify(await call('/v1/admin/orders/close', { orderId }), null, 2));
} else if (['grant-perpetual', 'revoke', 'disable'].includes(command)) {
  const [email] = rest;
  if (!email) throw new Error(`Usage: node admin.js ${command} <registered-email>`);
  const db = new DatabaseSync(env.DATABASE_PATH ?? './data/official.sqlite', { readOnly: true });
  const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim().toLowerCase());
  db.close();
  if (!account) throw new Error('Account not found: register from MetaWork first');
  const grant = command === 'grant-perpetual';
  await call(grant ? '/v1/admin/licenses' : '/v1/admin/revoke', { accountId: account.id, ...(grant ? { plan: 'internal_perpetual' } : { disable: command === 'disable' }) });
  console.log(grant ? 'Internal perpetual entitlement granted. Refresh entitlement in MetaWork.' : 'Sessions and entitlements revoked.');
} else {
  throw new Error('Usage: node admin.js <grant-perpetual|revoke|disable|orders|refund|refund-status|close-order|incidents> ...');
}
