// Manual probe: reproduce the panel pay flow against the deployed official service and
// print RAW responses to locate response-shape mismatches. Credentials are not needed.
const base = process.argv[2] ?? 'https://metawork.nexusfusionai.com';
const email = `probe-${Math.floor(Math.random() * 1e9)}@example.com`;
const password = 'probe-password-12345';
const j = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  console.log(`${method} ${path} -> ${response.status}`);
  console.log(text.slice(0, 1600));
  let value = null;
  try { value = JSON.parse(text); } catch {}
  return { status: response.status, value };
};

await j('/v1/auth/register', { method: 'POST', body: { email, password } });
const login = await j('/v1/auth/login', { method: 'POST', body: { email, password } });
const token = login.value?.sessionToken;
if (!token) process.exit(1);
const created = await j('/v1/orders', { method: 'POST', token, body: { plan: 'monthly', idempotencyKey: `probe-${Date.now()}` } });
const orderId = created.value?.orderId;
if (!orderId) process.exit(1);
await j(`/v1/orders/${orderId}/pay`, { method: 'POST', token, body: {} });
await j(`/v1/orders/${orderId}`, { token });
