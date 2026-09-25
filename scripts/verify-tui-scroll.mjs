import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Exercise the built client against retained, real Server data without submitting work.
const [conversationId, turnId, plannerRoot = 'planner/AnyFusion-Pi'] = process.argv.slice(2);
if (!conversationId || !turnId) {
  throw new Error('Usage: node scripts/verify-tui-scroll.mjs <conversationId> <turnId> [plannerRoot]');
}
const root = resolve(plannerRoot);
const load = relative => import(pathToFileURL(join(root, relative)).href);
const codingAgent = 'packages/coding-agent/dist';
const { TUI } = await load('packages/tui/dist/index.js');
const { GatewayClient } = await load(`${codingAgent}/anyfusion/gateway-client.js`);
const { GatewaySocketTransport } = await load(`${codingAgent}/anyfusion/gateway-socket-transport.js`);
const { MetaWorkTuiController } = await load(`${codingAgent}/modes/metawork-tui/controller.js`);
const { MetaWorkTuiApp } = await load(`${codingAgent}/modes/metawork-tui/app.js`);
const { initTheme } = await load(`${codingAgent}/modes/interactive/theme/theme.js`);

class CapturedTerminal {
  columns = 120;
  rows = 24;
  kittyProtocolActive = false;
  chunks = [];
  input = () => {};
  start(input) { this.input = input; }
  stop() {}
  async drainInput() {}
  write(chunk) { this.chunks.push(chunk); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

const manifest = JSON.parse(readFileSync(join(
  process.env.METAWORK_INSTALL_ROOT || join(process.env.HOME, '.metawork'),
  'server-endpoint.json',
), 'utf8'));
const transport = new GatewaySocketTransport(manifest.unixSocketPath);
const gateway = new GatewayClient(transport);
let submittedWork = 0;
const submitEnvelope = gateway.submitEnvelope.bind(gateway);
gateway.submitEnvelope = envelope => {
  if (['user_message', 'slash_command', 'cancel_turn'].includes(envelope.command.kind)) submittedWork += 1;
  return submitEnvelope(envelope);
};
const terminal = new CapturedTerminal();
const ui = new TUI(terminal);
let app;
const controller = new MetaWorkTuiController({
  gateway, conversationId, onStateChange: view => app?.handleView(view),
});
const timeout = setTimeout(() => {
  console.error('TUI scroll verification timed out');
  process.exit(1);
}, 20_000);
try {
  initTheme('dark');
  app = new MetaWorkTuiApp({
    ui, controller,
    preferences: { load: () => ({ theme: 'dark' }), save: () => {} },
    onExit: () => {},
  });
  app.start();
  await controller.start();
  controller.selectTurnById(turnId);
  await controller.openTaskPanel();
  const view = controller.getView();
  assert.equal(view.client.connection, 'ready');
  assert.equal(view.selectedTurn?.id, turnId);
  assert.equal(view.selectedTurn.status, 'completed');
  assert.ok(view.selectedTurn.answer.length > 1000, 'Use a real long result');
  assert.deepEqual(view.visibleTurns.filter(turn => turn.status === 'running' && !turn.userInput.trim()), []);
  const heading = view.selectedTurn.answer.split('\n').find(line => line.trim()).replace(/^#+\s*/, '');
  const frame = () => app.root.render(terminal.columns).map(stripVTControlCharacters).join('\n');
  terminal.input('scroll-verification-draft');
  const checks = [];
  for (const columns of [80, 120]) {
    terminal.columns = columns;
    for (const [name, up, down] of [
      ['legacy', '\x1b[5~', '\x1b[6~'],
      ['kitty-repeat', '\x1b[5;1:2~', '\x1b[6;1:2~'],
      ['kitty-keypad', '\x1b[57421u', '\x1b[57422u'],
      ['shift', '\x1b[5;2~', '\x1b[6;2~'],
      ['wheel', '\x1b[<64;10;8M', '\x1b[<65;10;8M'],
    ]) {
      frame();
      for (let i = 0; i < 500; i += 1) terminal.input(down);
      const bottom = frame();
      let sawHeading = false;
      let top = bottom;
      for (let i = 0; i < 500; i += 1) {
        terminal.input(up);
        const next = frame();
        sawHeading ||= next.includes(heading);
        if (next === top) break;
        top = next;
      }
      assert.notEqual(top, bottom, `${name}/${columns}: scrolling must change the viewport`);
      assert.ok(sawHeading, `${name}/${columns}: report heading must be reachable`);
      app.handleView(controller.getView());
      assert.equal(frame(), top, 'A state refresh must preserve reading position');
      for (let i = 0; i < 500; i += 1) terminal.input(down);
      assert.equal(frame(), bottom, `${name}/${columns}: scrolling back restores the end`);
      assert.equal(app.editor.getText(), 'scroll-verification-draft');
      checks.push(`${name}/${columns}`);
    }
  }
  assert.equal(submittedWork, 0);
  assert.deepEqual(controller.getView().client.notices.filter(notice => notice.kind === 'error'), []);
  app.stop();
  assert.ok(terminal.chunks.join('').includes('\x1b[?1006l\x1b[?1000l'));
  console.log(JSON.stringify({
    releaseId: manifest.releaseId, conversationId, turnId,
    answerLength: view.selectedTurn.answer.length, checks,
    preservedDraft: true, submittedWork, status: 'PASS',
  }));
} finally {
  clearTimeout(timeout);
  controller.stop();
  transport.close();
  app?.stop();
  ui.stop();
}
