import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Read-only verification against a running Server and an existing Conversation.
const [conversationId, turnId, plannerRoot = 'planner/AnyFusion-Pi'] = process.argv.slice(2);
if (!conversationId || !turnId) {
  throw new Error('Usage: node scripts/verify-tui-billing.mjs <conversationId> <turnId> [plannerRoot]');
}
const dist = resolve(plannerRoot, 'packages/coding-agent/dist');
const load = relative => import(pathToFileURL(join(dist, relative)).href);
const { GatewayClient } = await load('anyfusion/gateway-client.js');
const { GatewaySocketTransport } = await load('anyfusion/gateway-socket-transport.js');
const { MetaWorkTuiController } = await load('modes/metawork-tui/controller.js');
const { MetaWorkTaskDashboard } = await load('modes/metawork-tui/components/task-dashboard-panel.js');
const { initTheme } = await load('modes/interactive/theme/theme.js');
const manifest = JSON.parse(readFileSync(join(
  process.env.METAWORK_INSTALL_ROOT || join(process.env.HOME, '.metawork'),
  'server-endpoint.json',
), 'utf8'));
const transport = new GatewaySocketTransport(manifest.unixSocketPath);
const gateway = new GatewayClient(transport);
let disconnects = 0;
gateway.onDisconnect(() => { disconnects += 1; });
const controller = new MetaWorkTuiController({ gateway, conversationId });
const timeout = setTimeout(() => {
  console.error('TUI billing verification timed out');
  controller.stop();
  transport.close();
  process.exitCode = 1;
}, 15_000);
try {
  initTheme('dark');
  await controller.start();
  controller.selectTurnById(turnId);
  await controller.openTaskPanel();
  const view = controller.getView();
  assert.equal(view.selectedTurn?.id, turnId);
  const turn = view.selectedTurn;
  assert.ok(turn.taskId, 'Turn must have a Task');
  assert.ok(turn.turnBill, 'Turn bill must reach the controller through the socket');
  assert.ok(turn.turnBill.stageBreakdown.length, 'Bill must contain model usage');
  assert.ok(turn.taskUsageSummary, 'Task usage summary must reach the controller');
  assert.equal(view.client.connection, 'ready');
  assert.deepEqual(view.client.notices.filter(notice => notice.kind === 'error'), []);
  assert.equal(disconnects, 0, 'Queries must not disconnect the client');
  const receipt = await gateway.getTaskView(conversationId, turnId, turn.taskId);
  assert.equal(receipt.status, 'accepted', `Task view must still work after billing queries: ${receipt.reason}`);
  const panel = new MetaWorkTaskDashboard(() => ({
    selectedTurn: controller.getView().selectedTurn,
    connectionLabel: 'ready',
    expanded: false,
  }));
  for (const width of [36, 40, 45, 52]) {
    const text = panel.render(width).map(stripVTControlCharacters).join('\n');
    assert.ok(!text.includes('账单 暂不可用'));
    if (turn.turnBill.amountMicroCoin !== null) {
      assert.ok(text.replace(/\s+/g, '').includes(`${turn.turnBill.amountMicroCoin}MetaCoin`));
    } else {
      assert.ok(text.includes('待确认'));
    }
    for (const row of turn.turnBill.stageBreakdown) {
      for (const value of [row.inputTokens, row.outputTokens, row.totalTokens, row.assessedMetaCoin]) {
        if (value !== null) assert.ok(text.includes(value), `Missing ${value} at width ${width}`);
      }
    }
    if (width === 36) console.log(text);
  }
  console.log('PASS: live socket -> controller -> Task Dashboard; billing, Task queries, widths 36/40/45/52; no disconnects');
} finally {
  clearTimeout(timeout);
  controller.stop();
  transport.close();
}
