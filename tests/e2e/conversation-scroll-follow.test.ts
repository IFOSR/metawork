import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const acceptance = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

acceptance('conversation stream scroll behavior', () => {
  it('follows the stream until the user reads upward, then stays put until returning to latest', async () => {
    const bundle = await build({
      stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: String.raw`
        import { createRoot } from 'react-dom/client';
        import { ConversationEntityStore } from './src/observation/conversation-store';
        import { ObservedConversationView } from './src/observation/ObservedConversationView';

        const store = new ConversationEntityStore();
        let revision = 1;
        let streamPass = 0;
        const line = (index) => streamPass > 0 && index === 0
          ? ('最新流式输出。'.repeat(80) + '\\n').repeat(40 + streamPass * 10)
          : ('历史内容。'.repeat(24) + '\\n').repeat(40);
        const turn = (index) => ({
          id: 'turn-' + index, conversationId: 'scroll', requestId: 'request-' + index,
          revision, firstSequence: index, lastSequence: index, userInput: '问题 ' + index,
          userInputRef: null, answer: line(index), answerRef: null, resultId: null,
          certification: null, completeness: null, resultOffset: 0, resultPreviewOmitted: false,
          status: 'completed', deliveryStatus: 'ready', taskId: null,
          startedAt: '2026-10-27T00:00:00.000Z', completedAt: '2026-10-27T00:01:00.000Z',
          interactionKind: 'ai_turn',
        });
        const page = () => ({
          asOf: { epoch: 'epoch', revision },
          turns: [turn(0)], nextCursor: null,
        });
        const http = {
          getConversationView: async () => page(),
          getConversationTrace: async () => ({ events: [], nextCursor: null }),
          getConversationContent: async () => ({ text: '', nextOffset: 0, byteLength: 0 }),
        };
        const ws = {
          conversations: store,
          observations: { latest() {} },
          query: async (conversationId, command) => command.kind === 'get_query_bill_for_turn'
            ? { turnId: command.turnId, turnBill: null } : null,
        };
        window.growStream = () => { streamPass++; revision++; store.baseline('scroll', page()); };
        createRoot(document.getElementById('root')).render(
          <main className="workspace-canvas" style={{ height: 620, overflow: 'auto', padding: 24 }}>
            <ObservedConversationView conversationId="scroll" ws={ws} http={http}
              memory={{ anchors: new Map([['scroll', { turnId: 'turn-0', offset: 0, bottom: true }]]), heights: new Map() }}
              onOpenTrajectory={() => {}} onOpenBilling={() => {}}
              onOpenArtifact={() => {}} onOpenSubtaskDetail={() => {}} />
          </main>
        );
      ` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const server = createServer((request, response) => {
      const isBundle = request.url === '/bundle.js';
      const isStyles = request.url === '/styles.css';
      response.setHeader('Content-Type', isBundle ? 'text/javascript' : isStyles ? 'text/css' : 'text/html');
      response.end(isBundle ? bundle.outputFiles[0]!.text : isStyles ? styles
        : '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      const port = (server.address() as { port: number }).port;
      browser = await launchBrowser(port, 'conversation-scroll-follow');
      await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn]') && (() => {
        const c = document.querySelector('.workspace-canvas'); return c.scrollHeight > c.clientHeight * 2;
      })()`);
      await waitForExpression(browser.cdp, `(() => {
        const c = document.querySelector('.workspace-canvas');
        return c.scrollTop > 500 && !document.querySelector('.back-to-latest');
      })()`, 2_000);
      const detached = await browser.cdp.evaluate(`(() => {
        const c = document.querySelector('.workspace-canvas');
        c.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        c.scrollTop = Math.max(0, c.scrollTop - 260);
        return c.scrollTop;
      })()`);
      await waitForExpression(browser.cdp, `document.querySelector('.back-to-latest') !== null`);
      await browser.cdp.evaluate(`window.growStream()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterGrowth = await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`);
      expect(Math.abs(Number(afterGrowth) - Number(detached))).toBeLessThanOrEqual(64);

      await browser.cdp.evaluate(`document.querySelector('.back-to-latest').click()`);
      await waitForExpression(browser.cdp, `document.querySelector('.back-to-latest') === null`);
    } finally {
      await browser?.close();
      await new Promise<void>(done => server.close(() => done()));
    }
  }, 30_000);
});
