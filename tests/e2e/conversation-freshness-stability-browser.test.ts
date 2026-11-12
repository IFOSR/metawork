import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

describe.runIf(process.env.RUN_BROWSER_E2E === '1')('observed conversation background freshness', () => {
  it('keeps completed reports still across freshness cycles, polling, persistent sync and reconnect', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    const bundle = await build({
      stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: String.raw`
        import { createRoot } from 'react-dom/client';
        import { ObservedConversationView } from './src/observation/ObservedConversationView';
        import { ConversationEntityStore } from './src/observation/conversation-store';
        const store = new ConversationEntityStore();
        const turn = { id: 'report', conversationId: 'geo', revision: 1, firstSequence: 1, lastSequence: 1,
          userInput: '收集上海做小红书 GEO 的公司', userInputRef: null, answerRef: null,
          answer: '## 已完成的报告\n\n' + '公司信息、联系方式与核验结论。\n\n'.repeat(160),
          status: 'completed', taskId: 'geo-task', startedAt: '2026-11-11T10:00:00Z', completedAt: '2026-11-11T10:10:00Z' };
        const baseline = { head: { epoch: 'epoch', revision: 1, journalSequence: 1 }, turns: [turn], nextCursor: null };
        window.polls = 0;
        const http = { getConversationView: () => new Promise(() => {}),
          getConversationTrace: async () => { window.polls++; return { events: [] }; },
          getTaskWorkGraph: async () => ({ nodes: [], edges: [] }) };
        const ws = { conversations: store, observations: { latest() {} }, query: async () => ({
          targetConversationId: 'geo', turnId: 'report', taskId: 'geo-task',
          lifecycle: { status: 'succeeded', stateVersion: 1 }, timeline: null, artifacts: [] }) };
        window.freshness = preparing => store.apply({ kind: 'freshness', conversationId: 'geo', observationId: 'obs',
          sourceSequence: preparing ? null : 1, projectedSequence: 1, preparing });
        window.disconnect = () => store.disconnected();
        window.populate = () => store.baseline('geo', baseline);
        window.updateAnswer = () => store.apply({ kind: 'patch', conversationId: 'geo', observationId: 'obs', change: {
          epoch: 'epoch', prevRevision: 1, revision: 2, turn: { ...turn, revision: 2,
            answer: turn.answer + '\n\nREAL_UPDATE_RECEIVED' } } });
        createRoot(document.getElementById('root')).render(
          <main className="workspace-canvas" style={{ height: '100vh', overflow: 'auto' }}>
            <ObservedConversationView conversationId="geo" ws={ws} http={http}
              memory={{ anchors: new Map(), heights: new Map() }} onOpenTrajectory={() => {}}
              onOpenArtifact={() => {}} onOpenSubtaskDetail={() => {}} />
          </main>);
      ` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:8788/__freshness_stability__/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
        body: path.endsWith('.js') ? bundle.outputFiles[0]!.text : path.endsWith('.css') ? styles
          : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><main id="root"></main><script type="module" src="fixture.js"></script>' });
    });
    const geometry = () => page.evaluate(() => {
      const canvas = document.querySelector('.workspace-canvas')!;
      const answer = document.querySelector('.final-answer')!;
      return { scroll: canvas.scrollTop, height: canvas.scrollHeight, answerTop: answer.getBoundingClientRect().top };
    });
    try {
      await page.goto('http://127.0.0.1:8788/__freshness_stability__/');
      await page.getByText('正在读取会话…', { exact: true }).waitFor();
      await page.evaluate(() => (window as any).populate());
      await page.locator('.final-answer').waitFor();
      await page.waitForTimeout(300);
      for (const width of [1440, 756, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // Test the tail, then an actual user wheel gesture into the report.
        await page.waitForTimeout(300);
        for (const reading of [false, true]) {
          if (reading) {
            await page.mouse.move(Math.min(width - 20, 350), 400);
            await page.mouse.wheel(0, -1400);
            await page.waitForTimeout(300);
          }
          const before = await geometry();
          await page.evaluate(() => {
            (window as any).answerNode = document.querySelector('.final-answer');
            (window as any).freshness(true);
          });
          await page.waitForTimeout(150);
          // Ordinary sub-second background lag must not flash a loading message.
          expect(await page.locator('.conversation-state').count()).toBe(0);
          expect(await geometry()).toEqual(before);
          // A sustained lag remains visible, without moving the report at all.
          await page.getByText('正在同步会话，已有内容可继续浏览。', { exact: true }).waitFor();
          expect(await geometry()).toEqual(before);
          await page.evaluate(() => (window as any).freshness(false));
          await page.waitForTimeout(100);
          expect(await geometry()).toEqual(before);
          expect(await page.evaluate(() => document.querySelector('.final-answer') === (window as any).answerNode)).toBe(true);
          for (let cycle = 0; cycle < 3; cycle++) {
            await page.evaluate(() => (window as any).freshness(true));
            await page.waitForTimeout(50);
            await page.evaluate(() => (window as any).freshness(false));
            await page.waitForTimeout(50);
            expect(await geometry()).toEqual(before);
          }
          await page.evaluate(() => (window as any).disconnect());
          await page.getByText('连接已断开，正在重连…', { exact: true }).waitFor();
          expect(await geometry()).toEqual(before);
          await page.evaluate(() => (window as any).freshness(false));
          await page.waitForTimeout(100);
          expect(await geometry()).toEqual(before);
        }
      }
      expect(await page.evaluate(() => (window as any).polls)).toBeGreaterThanOrEqual(3);
      await page.evaluate(() => (window as any).updateAnswer());
      await page.getByText('REAL_UPDATE_RECEIVED', { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});
