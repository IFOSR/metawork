import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const Database = require('better-sqlite3');

/** Deterministic history fixture in the smoke's isolated installation; no model request. */
export async function verifyConversationChart(app, page, root, installRoot) {
  const workspace = join(root, 'chart-workspace'); await mkdir(workspace, { recursive: true });
  const route = await page.evaluate(async path => {
    const selected = await fetch('/api/workspaces/select', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    const state = await selected.json();
    if (!selected.ok || !state.activeWorkspaceId) throw new Error('chart workspace selection failed');
    const created = await fetch(`/api/workspaces/${state.activeWorkspaceId}/conversations`, { method: 'POST' });
    const result = await created.json();
    if (!created.ok || !result.session?.session?.id) throw new Error(`chart conversation creation failed: ${created.status}`);
    return { workspaceId: state.activeWorkspaceId, conversationId: result.session.session.id };
  }, workspace);
  const spec = { version: 1, type: 'bar', title: '桌面季度收入', unit: '万元', source: '安装包验收数据（非实际经营数据）',
    labels: ['一季度', '二季度'], series: [{ name: '收入', values: [120, 150] }] };
  const turn = { id: 'packaged-chart-turn', conversationId: route.conversationId, status: 'completed',
    userInput: '用表格和图展示季度收入（测试数据）',
    finalAnswer: '| 季度 | 收入（万元） |\n| --- | ---: |\n| 一季度 | 120 |\n| 二季度 | 150 |\n\n'
      + '```chart\n' + JSON.stringify(spec) + '\n```\n' };
  const body = JSON.stringify(turn);
  const db = new Database(join(installRoot, 'accounts/local-default/data/anyfusion.db'));
  try {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO conversation_history_streams(account_id, conversation_id, kind, last_sequence)
        VALUES ('local-default', ?, 'conversation', 0)`).run(route.conversationId);
      const { last_sequence: sequence } = db.prepare(`UPDATE conversation_history_streams SET last_sequence = last_sequence + 1
        WHERE account_id = 'local-default' AND conversation_id = ? AND kind = 'conversation' RETURNING last_sequence`).get(route.conversationId);
      db.prepare(`INSERT INTO conversation_history_turns(account_id,conversation_id,kind,sequence,turn_id,body_json,byte_length)
        VALUES ('local-default',?,'conversation',?,?,?,?)`).run(route.conversationId, sequence, turn.id, body, Buffer.byteLength(body));
    }).immediate();
  } finally { db.close(); }
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/#workspace=${route.workspaceId}&conversation=${route.conversationId}&turn=${turn.id}`);
  const reply = page.locator(`[data-observed-turn="${turn.id}"] .final-answer`);
  const chart = reply.getByRole('figure', { name: spec.title, exact: true });
  await chart.locator('svg').waitFor({ timeout: 30000 });
  assert.equal(await reply.locator('table tbody tr').first().locator('td').nth(1).textContent(), '120');
  assert.equal(await reply.locator('table td').first().evaluate(node => getComputedStyle(node).borderRightWidth), '1px');
  const path = join(root, '季度收入.png');
  await app.evaluate(({ dialog }, filePath) => {
    globalThis.restoreChartSave = dialog.showSaveDialog;
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.chartSaveOptions = options;
      return { canceled: false, filePath };
    };
  }, path);
  try {
    await chart.getByRole('button', { name: '保存图表 PNG', exact: true }).click();
    await chart.getByRole('button', { name: '在 Finder 中显示', exact: true }).waitFor();
    const bytes = await readFile(path);
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert(bytes.readUInt32BE(16) > 100); assert(bytes.readUInt32BE(20) > 100);
    assert.equal((await app.evaluate(() => globalThis.chartSaveOptions)).defaultPath, `${spec.title}.png`);
    const evidence = 'apps/desktop/release/evidence'; await mkdir(evidence, { recursive: true });
    await chart.screenshot({ path: join(evidence, 'packaged-chart.png') });
    await writeFile(join(evidence, 'packaged-chart-export.png'), bytes);
    await writeFile(join(evidence, 'packaged-chart.json'), JSON.stringify({ table: true, localChart: true,
      nativePngSave: true, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), modelRequest: false }, null, 2));
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.restoreChartSave; });
  }
  console.log('Packaged conversation table, chart and native PNG save passed.');
}
