// Production gateway probe: create → prepay → close → verify, leaving nothing unpaid-open.
import process from 'node:process';
import { createHubClient } from '../hub-payments.js';

const env = process.env;
const hub = createHubClient({
  baseUrl: env.PAYMENT_HUB_BASE_URL, clientId: env.PAYMENT_HUB_CLIENT_ID,
  clientSecret: env.PAYMENT_HUB_CLIENT_SECRET,
});
const order = await hub.createHubOrder({
  amountCents: 990,
  description: `MetaWork 生产网关签名验证 ${new Date().toISOString()}`,
  expireMinutes: 30,
  idempotencyKey: `probe-prod-${Date.now()}`,
});
console.log(`PASS create order_no=${order.order_no} status=${order.status} desc=${order.status_desc}`);
const prepay = await hub.prepayHubOrder(order.order_no, `probe-prepay-${order.order_no}`);
console.log(`PASS prepay status=${prepay.status} qr=${prepay.qr_code_url}`);
await hub.closeHubOrder(order.order_no, `probe-close-${order.order_no}`);
const closed = await hub.queryHubOrder(order.order_no);
console.log(`PASS close status=${closed.status} (${closed.status_desc})`);
