import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

// Browser-local fixture on the acceptance origin; no test server or persistent data writes.
describe.runIf(process.env.RUN_BROWSER_E2E === '1')('conversation copy and refresh stability', () => {
  it('keeps chart state and reading position across equal snapshots, copies full messages and updates changed answers', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    const bundle = await build({
      stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: String.raw`
        import { createRoot } from 'react-dom/client';
        import { ConversationTurnView } from './src/components/ConversationTurn';
        const root = createRoot(document.getElementById('root'));
        const spec = { version: 1, type: 'line', title: '稳定性验收', labels: ['一', '二'],
          series: [{ name: '收入', values: [1, 2] }] };
        const prompt = '完整问题：中文、换行与长文本\n' + '问题内容。'.repeat(1000);
        const answer = '## 稳定的回答\n\n' + '\x60\x60\x60chart\n' + JSON.stringify(spec)
          + '\n\x60\x60\x60\n\n' + '完整回答内容。\n\n'.repeat(200).trimEnd();
        let turn = { id: 'copy-turn', sessionId: 'copy-conversation', userInput: prompt,
          status: 'completed', finalAnswer: answer, artifacts: [], traceEvents: [], executionTimeline: null,
          startedAt: '2026-11-12T00:00:00Z', completedAt: '2026-11-12T00:01:00Z' };
        window.expected = { prompt, answer };
        window.refreshFixture = (text) => {
          turn = { ...turn, artifacts: [], traceEvents: [], ...(text === undefined ? {} : { finalAnswer: text }) };
          root.render(<ConversationTurnView turn={turn} onOpenArtifact={() => {}} onOpenTrajectory={() => {}} />);
        };
        window.refreshFixture();
      ` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:8788/__copy_stability__/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
        body: path.endsWith('.js') ? bundle.outputFiles[0]!.text : path.endsWith('.css') ? styles
          : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><main id="root"></main><script type="module" src="fixture.js"></script>' });
    });
    try {
      await page.goto('http://127.0.0.1:8788/__copy_stability__/');
      const chart = page.getByRole('figure', { name: '稳定性验收', exact: true });
      await chart.locator('svg').first().waitFor();
      await chart.locator('summary').click();
      const legend = chart.getByRole('button', { name: '收入', exact: true });
      await legend.click();
      await page.evaluate(() => {
        const host = window as any;
        host.chartNode = document.querySelector('.inline-chart');
        host.scrollBefore = window.scrollY;
      });
      for (let index = 0; index < 6; index++) {
        await page.evaluate(() => (window as any).refreshFixture());
        await page.waitForTimeout(100);
      }
      expect(await chart.locator('details').getAttribute('open')).not.toBeNull();
      expect(await legend.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate(() => document.querySelector('.inline-chart') === (window as any).chartNode)).toBe(true);
      expect(await page.evaluate(() => Math.abs(window.scrollY - (window as any).scrollBefore))).toBeLessThan(2);

      for (const [label, field] of [['复制问题', 'prompt'], ['复制回答', 'answer']]) {
        const copy = page.getByRole('button', { name: label, exact: true });
        await copy.click();
        await page.waitForFunction(label => document.querySelector(`[aria-label="${label}"]`)?.getAttribute('data-copy-status') === 'copied', label);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.evaluate(field => (window as any).expected[field], field));
      }
      // A denied async API (including LAN HTTP without that API) uses the user-gesture fallback.
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } } }));
      const copy = page.getByRole('button', { name: '复制回答', exact: true });
      await copy.focus();
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.final-answer h2')!);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      });
      const selectedBeforeCopy = await page.evaluate(() => window.getSelection()!.toString());
      const scrollBeforeCopy = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[aria-label="复制回答"]')?.getAttribute('data-copy-status') === 'copied');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('复制回答');
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeCopy);
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selectedBeforeCopy);
      await page.evaluate(() => { delete (navigator as any).clipboard; });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.evaluate(() => (window as any).expected.answer));

      await page.evaluate(() => (window as any).refreshFixture('## 更新后的答案\n\n新的内容。'));
      await page.getByRole('heading', { name: '更新后的答案' }).waitFor();
      expect(await chart.count()).toBe(0);
      await copy.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="复制回答"]')?.getAttribute('data-copy-status') === 'copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('## 更新后的答案\n\n新的内容。');
      await page.setViewportSize({ width: 390, height: 844 });
      expect((await copy.boundingBox())!.width).toBeGreaterThanOrEqual(28);
      expect(await copy.evaluate(node => getComputedStyle(node).borderWidth)).toBe('0px');
      // Denied fallback must report failure instead of a false success checkmark.
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = () => false;
      });
      await copy.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="复制回答"]')?.getAttribute('data-copy-status') === 'failed');
      expect(await copy.getAttribute('title')).toContain('复制失败');
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});
