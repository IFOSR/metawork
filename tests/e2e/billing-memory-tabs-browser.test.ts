import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

// Browser-local scenarios on the acceptance origin; never modify the user's memories.
describe.runIf(process.env.RUN_BROWSER_E2E === '1')('billing and memory workspace', () => {
  it('keeps usage readable and profiles the whole account across filters, mutations and failures', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    const bundle = await build({
      stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: String.raw`
        import { createRoot } from 'react-dom/client';
        import { MemoryAssetsPanel } from './src/components/MemoryAssetsPanel';
        import { TokenUsageView } from './src/components/TokenUsageView';
        const root = createRoot(document.getElementById('root'));
        const host = window;
        let key = 0;
        const initial = () => Array.from({ length: 215 }, (_, id) => ({
          memoryId: 'm-' + id, tdaiMemoryId: 'u-' + id, layer: id === 214 ? 'l3' : 'l1',
          title: id === 214 ? '完整账号画像' : '记忆 ' + id, preview: '偏好中文，关注软件开发与投资',
          type: 'instruction', enabled: id !== 0, source: 'conversation', workspaceId: null,
          createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z',
        }));
        host.memories = initial(); host.profileReads = 0;
        const api = {
          status: async () => ({ enabled: true, mode: 'enabled', engineReady: true }),
          listAssets: async (input) => {
            if (input.limit === 200) {
              host.profileReads++;
              if (host.failProfile) throw new Error('engine_connection_refused');
            }
            const filtered = host.memories.filter(item => (!input.query || item.title.includes(input.query))
              && (!input.layer || item.layer === input.layer)
              && (input.enabled === undefined || input.enabled === item.enabled));
            return { items: filtered.slice(input.offset, input.offset + input.limit),
              total: filtered.length, unfilteredTotal: host.memories.length, mode: 'enabled', degraded: false };
          },
          getAsset: async id => ({ ...host.memories.find(item => item.memoryId === id), content: '## 完整画像原文\n\n偏好中文，关注软件开发与投资。' }),
          setAssetEnabled: async (id, enabled) => { host.memories = host.memories.map(item => item.memoryId === id ? { ...item, enabled } : item); },
          deleteAsset: async id => { host.memories = host.memories.filter(item => item.memoryId !== id); },
        };
        const http = { getTokenUsageTimeline: async query => {
          await new Promise(resolve => setTimeout(resolve, host.usageDelay || 0));
          if (host.failUsage) throw new Error('usage_store_unavailable');
          const series = [{ id: 'one', label: '模型名称-' + 'long-model-id-'.repeat(12), tokens: '42' }, { id: 'two', label: '第二个模型', tokens: '8' }];
          const day = { date: '2026-11-12', totalTokens: '50', includedTokens: '42', onDemandTokens: '8', unattributedTokens: '0', missingCalls: 0, values: { one: '42', two: '8' } };
          return { groupBy: query.groupBy, range: { start: '2026-11-12', end: '2026-11-12' },
            totals: { ...day, calls: host.emptyUsage ? 0 : 2, totalTokens: host.emptyUsage ? '0' : '50' },
            days: [day], series, quota: { providers: [] } };
        } };
        host.showMemory = (empty = false) => {
          host.memories = empty ? [] : initial();
          root.render(<MemoryAssetsPanel key={++key} api={api} onOpenSettings={() => {}} />);
        };
        host.showUsage = () => root.render(<TokenUsageView key={++key} http={http} />);
        host.showUsage();
      ` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:8788/__billing_memory__/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
        body: path.endsWith('.js') ? bundle.outputFiles[0]!.text : path.endsWith('.css') ? styles
          : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"><main id="root"></main><script type="module" src="fixture.js"></script>' });
    });
    try {
      await page.goto('http://127.0.0.1:8788/__billing_memory__/');
      await page.locator('.usage-summary').waitFor();
      const usageSummary = await page.locator('.usage-summary').innerText();
      const legend = page.locator('.usage-legend button').first();
      await legend.click();
      expect(await legend.getAttribute('aria-pressed')).toBe('false');
      expect(await page.locator('.usage-summary').innerText()).toBe(usageSummary);
      await page.locator('.usage-legend button').nth(1).click();
      expect(await page.locator('.usage-chart-hint').innerText()).toContain('所有系列已隐藏');
      await page.locator('.usage-table summary').click();
      expect(await page.locator('.usage-table tbody tr').count()).toBe(1);
      await page.evaluate(() => { (window as any).usageDelay = 500; (window as any).failUsage = true; });
      await page.getByLabel('统计维度').selectOption('provider');
      expect(await page.locator('.usage-summary').innerText()).toBe(usageSummary);
      await page.getByRole('alert').filter({ hasText: 'usage_store_unavailable' }).waitFor();
      expect(await page.locator('.usage-loading').innerText()).toContain('上次成功');
      await page.evaluate(() => { (window as any).failUsage = false; (window as any).usageDelay = 0; });
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      await page.locator('.usage-workspace[aria-busy="false"]').waitFor();
      expect(await page.getByRole('alert').count()).toBe(0);
      await page.getByLabel('时间区间').selectOption('custom');
      await page.locator('.usage-workspace[aria-busy="false"]').waitFor();
      await page.getByLabel('开始日期').fill('2025-01-01');
      await page.getByLabel('结束日期').fill('2026-11-12');
      await page.getByRole('button', { name: '应用日期' }).click();
      await page.getByRole('alert').filter({ hasText: '最长支持 366 天' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.evaluate(() => { (window as any).emptyUsage = true; (window as any).showUsage(); });
      await page.getByText('这段时间还没有用量记录。', { exact: true }).waitFor();

      await page.evaluate(() => (window as any).showMemory());
      await page.locator('.memory-profile-total strong').filter({ hasText: /^215$/ }).waitFor();
      expect(await page.locator('.memory-profile-total').innerText()).toContain('214 条可使用');
      const reads = await page.evaluate(() => (window as any).profileReads);
      await page.getByLabel('搜索记忆内容').fill('完整账号画像');
      await page.locator('.memory-list-summary').filter({ hasText: '找到 1 条' }).waitFor();
      expect(await page.locator('.memory-profile-total strong').innerText()).toBe('215');
      expect(await page.evaluate(() => (window as any).profileReads)).toBe(reads);
      await page.locator('.memory-profile-highlights button').first().click();
      await page.getByRole('heading', { name: '完整画像原文' }).waitFor();
      await page.getByRole('switch').uncheck();
      await page.getByRole('button', { name: '关闭记忆详情' }).click();
      await page.locator('.memory-profile-total').filter({ hasText: '213 条可使用' }).waitFor();
      await page.evaluate(() => { (window as any).failProfile = true; });
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'engine_connection_refused' }).waitFor();
      expect(await page.locator('.memory-row').count()).toBe(1);
      await page.evaluate(() => { (window as any).failProfile = false; });
      await page.getByRole('button', { name: '重试画像' }).click();
      await page.locator('.memory-profile-total strong').filter({ hasText: /^215$/ }).waitFor();
      expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.evaluate(() => (window as any).showMemory(true));
      await page.locator('.memory-profile-total strong').filter({ hasText: /^0$/ }).waitFor();
      expect(await page.locator('.memory-profile').innerText()).toContain('还没有形成记忆画像');
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});
