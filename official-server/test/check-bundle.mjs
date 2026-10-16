import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = '/home/xlsun/metawork/web/dist/assets';
const markers = ['订阅', '取消订单', '微信扫码支付', 'official-auth/orders', '刷新二维码'];
for (const file of readdirSync(dir).filter(f => f.startsWith('index-') && f.endsWith('.js'))) {
  const text = readFileSync(join(dir, file), 'utf8');
  console.log(file);
  for (const marker of markers) console.log(`  ${marker} = ${(text.match(new RegExp(marker, 'gu')) ?? []).length}`);
}
