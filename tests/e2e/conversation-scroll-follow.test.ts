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
        window.growStream = () => {
          streamPass++; revision++;
          store.baseline('scroll', { head: { epoch: 'epoch', revision }, turns: [turn(0)], nextCursor: null });
        };
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
        return c.scrollTop > 500 && c.scrollHeight - c.clientHeight - c.scrollTop <= 1
          && !document.querySelector('.back-to-latest');
      })()`, 2_000);
      // Let measurements settle before sampling the wheel's actual movement.
      await new Promise(resolve => setTimeout(resolve, 300));
      const beforeUp = Number(await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`));
      const gesture = await browser.cdp.evaluate(`(() => {
        const c = document.querySelector('.workspace-canvas');
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`) as { x: number; y: number };
      await browser.cdp.send('Input.dispatchMouseEvent', {
        // Keep this smaller than the follow threshold: explicit upward
        // intent must still detach from the stream even near the tail.
        type: 'mouseWheel', x: gesture.x, y: gesture.y, deltaX: 0, deltaY: -40,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const detached = await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`);
      expect(beforeUp - Number(detached)).toBeGreaterThan(20);
      expect(beforeUp - Number(detached)).toBeLessThan(64);
      await waitForExpression(browser.cdp, `document.querySelector('.back-to-latest') !== null`);
      // Keep the stream growing after the user leaves the tail. Every update
      // must preserve the reading position; one update is insufficient to
      // catch a layout/scroll-event race.
      for (let index = 0; index < 5; index += 1) {
        await browser.cdp.evaluate(`window.growStream()`);
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      const afterGrowth = await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`);
      expect(Math.abs(Number(afterGrowth) - Number(detached))).toBeLessThanOrEqual(2);

      // Scrolling down while detached remains a user navigation gesture; it
      // must not be mistaken for native anchoring and snapped back.
      const beforeDown = Number(afterGrowth);
      await browser.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: gesture.x, y: gesture.y, deltaX: 0, deltaY: 120,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterDown = Number(await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`));
      expect(afterDown).toBeGreaterThan(beforeDown + 20);

      // Scrollbar/accessibility scrolling emits scroll events without a wheel
      // gesture. Accept successive position changes instead of snapping back.
      await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop -= 180`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterDrag = Number(await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').scrollTop`));
      expect(Math.abs(afterDrag - (afterDown - 180))).toBeLessThanOrEqual(2);

      await browser.cdp.evaluate(`document.querySelector('.back-to-latest').click()`);
      await waitForExpression(browser.cdp, `document.querySelector('.back-to-latest') === null`);
      const atTail = `(() => { const c = document.querySelector('.workspace-canvas');
        return Math.abs(c.scrollHeight - c.clientHeight - c.scrollTop) <= 2; })()`;
      await waitForExpression(browser.cdp, atTail);
      await browser.cdp.evaluate(`window.growStream()`);
      await waitForExpression(browser.cdp, atTail);
    } finally {
      await browser?.close();
      await new Promise<void>(done => server.close(() => done()));
    }
  }, 30_000);
});
