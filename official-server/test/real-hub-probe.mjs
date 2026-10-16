// One-shot field bisect for OPC_PARAM_INVALID on the real gateway. Env-only credentials.
import process from 'node:process';
import { createHubClient } from '../hub-payments.js';

const env = process.env;
const hub = createHubClient({
  baseUrl: env.PAYMENT_HUB_BASE_URL, clientId: env.PAYMENT_HUB_CLIENT_ID,
  clientSecret: env.PAYMENT_HUB_CLIENT_SECRET,
});
const variants = [
  { name: 'full-with-ip-notify', body: { channel: 1, purpose: 2, amount_cents: 990, description: 'bisect full', expire_minutes: 30, notify_url: 'https://14.103.216.193:9222/v1/payments/notify' } },
  { name: 'no-notify', body: { channel: 1, purpose: 2, amount_cents: 990, description: 'bisect no-notify', expire_minutes: 30 } },
  { name: 'no-notify-no-description', body: { channel: 1, purpose: 2, amount_cents: 990, expire_minutes: 30 } },
  { name: 'no-notify-minimal', body: { channel: 1, purpose: 2, amount_cents: 990 } },
  { name: 'amount-100', body: { channel: 1, purpose: 2, amount_cents: 100, expire_minutes: 30 } },
];
for (const variant of variants) {
  try {
    const order = await hub.createHubOrder({
      amountCents: variant.body.amount_cents,
      description: variant.body.description,
      notifyUrl: variant.body.notify_url,
      expireMinutes: variant.body.expire_minutes,
      idempotencyKey: `probe-${variant.name}-${Date.now()}`,
    });
    console.log(`PASS ${variant.name} order_no=${order.order_no} status=${order.status} expire=${order.expire_time}`);
    process.exitCode = 0;
    break;
  } catch (error) {
    console.log(`FAIL ${variant.name} ${error.status} ${error.code} req=${error.requestId ?? ''}`);
    process.exitCode = 1;
  }
}
