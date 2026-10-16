// Verify the SERVED web bundle contains the new payment UI markers.
const base = process.argv[2] ?? 'http://127.0.0.1:8788';
const html = await (await fetch(`${base}/`)).text();
const asset = /\/assets\/index-[A-Za-z0-9_-]+\.js/u.exec(html)?.[0];
if (!asset) { console.log('FAIL no bundle reference in HTML'); process.exit(1); }
const js = await (await fetch(`${base}${asset}`)).text();
const markers = ['订阅', '取消订单', '订单列表', '微信扫码支付', '刷新二维码', 'official-auth'];
console.log(`bundle ${asset} (${Math.round(js.length / 1024)} KiB)`);
for (const marker of markers) console.log(`  ${marker} = ${(js.match(new RegExp(marker, 'gu')) ?? []).length}`);
