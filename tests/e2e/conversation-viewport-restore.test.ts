import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
const e2e = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

e2e('conversation viewport restoration', () => {
  it('loads a long report after restart with a saved offset but no measured heights', async () => {
    const bundle = await build({
      stdin: { resolveDir: resolve('.'), sourcefile: 'viewport-restore.tsx', loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from './web/node_modules/react-dom/client';
        import { ObservedConversationView } from './web/src/observation/ObservedConversationView';
        import { ConversationEntityStore } from './web/src/observation/conversation-store';
        const offset = Number(new URLSearchParams(location.search).get('offset') ?? 3815);
        const content = '# 历史报告\\n\\n' + '一段完整的历史报告内容。\\n\\n'.repeat(160) + 'REPORT_END';
        const bytes = new TextEncoder().encode(content).length;
        const store = new ConversationEntityStore();
        const turn = { id: 'turn', conversationId: 'history', requestId: 'request', revision: 1,
          firstSequence: 1, lastSequence: 1, userInput: '历史问题', userInputRef: null,
          answer: '报告预览', answerRef: { hash: 'a'.repeat(64), byteLength: bytes },
          resultId: null, certification: null, completeness: null, resultOffset: bytes,
          resultPreviewOmitted: true, status: 'completed', deliveryStatus: 'ready', taskId: null,
          startedAt: '2026-10-10T01:21:32Z', completedAt: '2026-10-10T01:25:26Z', interactionKind: 'ai_turn' };
        const page = { asOf: { epoch: 'epoch', revision: 1 }, turns: [turn], nextCursor: null };
        const memory = { anchors: new Map([['history', { turnId: 'turn', offset, bottom: false }]]), heights: new Map() };
        window.contentRequests = 0;
        const http = { getConversationView: async () => page,
          getConversationTrace: async () => ({ events: [], nextCursor: null }),
          getConversationContent: async () => {
            window.contentRequests++;
            await new Promise(done => { window.finishContent = done; });
            return { text: content, nextOffset: bytes, byteLength: bytes };
          } };
        const ws = { conversations: store, observations: { latest() {} }, query: async () => ({ turnBill: null }) };
        createRoot(document.getElementById('root')).render(
          <main className="workspace-canvas" style={{ height: 600, overflow: 'auto' }}>
            <ObservedConversationView conversationId="history" ws={ws} http={http} memory={memory}
              onOpenTrajectory={() => {}} onOpenBilling={() => {}} onOpenArtifact={() => {}} onOpenSubtaskDetail={() => {}} />
          </main>);
      ` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const styles = await readFile('web/src/styles.css', 'utf8');
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : request.url === '/styles.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/bundle.js' ? bundle.outputFiles[0]!.text : request.url === '/styles.css' ? styles
        : '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // The first value is the affected desktop's persisted offset. The second
      // covers stale positions after a font/window/content size change.
      for (const offset of [3815, 100000]) {
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?offset=${offset}`);
        await page.waitForFunction('window.contentRequests === 1', undefined, { timeout: 5000 });
        expect(await page.locator('[data-observed-turn]').count()).toBe(1);
        await page.evaluate('window.finishContent()');
        await page.waitForFunction("document.querySelector('.final-answer')?.textContent.includes('REPORT_END')");
        await page.waitForFunction((offset: number) => {
          const canvas = document.querySelector<HTMLElement>('.workspace-canvas')!;
          const turn = document.querySelector<HTMLElement>('[data-observed-turn]')!;
          const list = turn.parentElement!;
          const listTop = list.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop;
          const expected = listTop + Math.min(offset, Math.max(0, turn.getBoundingClientRect().height - canvas.clientHeight));
          return Math.abs(canvas.scrollTop - expected) < 2;
        }, offset);
        expect(await page.locator('[data-observed-turn]').evaluate(element => {
          const row = element.getBoundingClientRect();
          const canvas = element.closest('.workspace-canvas')!.getBoundingClientRect();
          return row.bottom > canvas.top && row.top < canvas.bottom;
        })).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>(done => server.close(() => done()));
    }
  }, 30_000);
});
