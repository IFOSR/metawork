// Local end-to-end probe: drive the LOCAL MetaWork server (port 8788) through the
// same flow as the browser: local login -> official register/login -> order -> pay.
// Prints every raw response; reads /tmp/pay-parse-fail.log if the client-side parse fails.
import fs from 'node:fs';
const base = 'http://127.0.0.1:8788';
let cookie = '';
const stamp = Date.now();
const j = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map(c => c.split(';')[0]).join('; ');
  const text = await response.text();
  console.log(`${method} ${path} -> ${response.status} :: ${text.slice(0, 260)}`);
  try { return JSON.parse(text); } catch { return null; }
};

await j('/api/auth/login', { method: 'POST', body: { username: 'admin', password: '123456' } });
const email = `localprobe-${stamp}@example.com`;
const password = 'localprobe-password-12345';
await j('/api/official-auth/register', { method: 'POST', body: { email, password } });
await j('/api/official-auth/login', { method: 'POST', body: { email, password } });
const order = await j('/api/official-auth/orders', { method: 'POST', body: { plan: 'monthly', idempotencyKey: `lp-${stamp}` } });
if (order?.orderId) {
  await j(`/api/official-auth/orders/${order.orderId}/pay`, { method: 'POST', body: {} });
  await j(`/api/official-auth/orders/${order.orderId}`);
}
try { console.log('--- fail log ---'); console.log(fs.readFileSync('/tmp/pay-parse-fail.log', 'utf8').slice(0, 1200)); } catch { console.log('--- no parse failures logged ---'); }
