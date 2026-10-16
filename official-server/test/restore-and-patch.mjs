import fs from 'node:fs';
const file = '/home/xlsun/metawork/src/authorization/official-service-client.ts';
// 1. Restore the clean source from the Windows checkout (untouched by the failed patch).
fs.copyFileSync('/mnt/e/opc/metawork/src/authorization/official-service-client.ts', file);
// 2. Re-apply the diagnostic logging patch on the clean file.
let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const marker = "if (!result.success) throw new OfficialAuthorizationError('订单支付响应无效', 'official_protocol_error');";
if (!text.includes(marker)) { console.error('marker missing'); process.exit(1); }
text = text.replace(marker,
  "if (!result.success) {\n    try { appendFileSync('/tmp/pay-parse-fail.log', JSON.stringify({ issues: result.error.issues, value }) + '\\n'); } catch {}\n    throw new OfficialAuthorizationError('订单支付响应无效', 'official_protocol_error');\n  }");
text = "import { appendFileSync } from 'node:fs';\n" + text;
fs.writeFileSync(file, text);
// sanity: definitions restored
for (const name of ['function parseAccount', 'function parseEntitlement', 'function parseOrderPayment']) {
  if (!text.includes(name)) { console.error(`missing ${name}`); process.exit(1); }
}
console.log('RESTORED+PATCHED');
