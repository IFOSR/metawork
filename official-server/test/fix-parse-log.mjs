import fs from 'node:fs';
const file = '/home/xlsun/metawork/src/authorization/official-service-client.ts';
let text = fs.readFileSync(file, 'utf8');
const good = `function parseOrderPayment(value: unknown): OfficialOrderPaymentResult {
  const result = z.object({ order: officialOrderShape, payment: officialPaymentShape.nullable() }).safeParse(value);
  if (!result.success) {
    try { appendFileSync('/tmp/pay-parse-fail.log', JSON.stringify({ issues: result.error.issues, value }) + '\\n'); } catch {}
    throw new OfficialAuthorizationError('订单支付响应无效', 'official_protocol_error');
  }
  return result.data;
}`;
const start = text.indexOf('function parseOrderPayment');
const end = text.indexOf('async function readBoundedResponse');
if (start === -1 || end === -1) { console.error('markers missing'); process.exit(1); }
text = text.slice(0, start) + good + '\n\n' + text.slice(end);
if (!text.includes("from 'node:fs'")) text = "import { appendFileSync } from 'node:fs';\n" + text;
text = text.replace('fs.appendFileSync', 'appendFileSync');
fs.writeFileSync(file, text);
console.log('FIXED');
