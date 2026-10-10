// Run only on the official host through SSH; the secret never appears in argv or output.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const env = { ...process.env };
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/u)) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/u);
  if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^['"]|['"]$/gu, '');
}
const [command, email] = process.argv.slice(2);
if (!['grant-perpetual', 'revoke', 'disable'].includes(command) || !email) throw new Error('Usage: node admin.js <grant-perpetual|revoke|disable> <registered-email>');
const db = new DatabaseSync(env.DATABASE_PATH ?? './data/official.sqlite', { readOnly: true });
const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim().toLowerCase());
db.close();
if (!account) throw new Error('Account not found: register from MetaWork first');
const grant = command === 'grant-perpetual';
const response = await fetch(`http://127.0.0.1:${env.PORT ?? 8780}/v1/admin/${grant ? 'licenses' : 'revoke'}`, {
  method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: account.id, ...(grant ? { plan: 'internal_perpetual' } : { disable: command === 'disable' }) }),
  signal: AbortSignal.timeout(10000), redirect: 'error',
});
if (!response.ok) throw new Error(`Administration failed: HTTP ${response.status}`);
console.log(grant ? 'Internal perpetual entitlement granted. Refresh entitlement in MetaWork.' : 'Sessions and entitlements revoked.');
