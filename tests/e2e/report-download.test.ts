import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createReportPdf } from '../../src/management/report-pdf.js';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
const e2e = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

e2e('report download browser flow', () => {
  it('downloads both formats, retries errors, and preserves native save/cancel/reveal behavior', async () => {
    const root = resolve('.');
    const source = '# 季度研究报告\n\n中文正文与 **重点结论**。\n\n| 指标 | 数值 |\n|---|---|\n| 收入 | 100 |';
    const compiled = await build({
      stdin: { contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ArtifactPreviewDrawer } from './web/src/components/ArtifactPreviewDrawer';
        import { HttpClient } from './web/src/api/http';
        const artifact = { artifactId: 'report', displayName: '季度研究报告.md', relativePath: '季度研究报告.md', previewKind: 'markdown', previewable: true, byteLength: 100, mediaType: 'text/markdown' };
        const root = createRoot(document.getElementById('root'));
        window.renderReport = (kind = 'markdown') => root.render(React.createElement(ArtifactPreviewDrawer, {
          key: kind, http: new HttpClient(), state: { status: 'ready', artifact: { ...artifact, previewKind: kind }, content: ${JSON.stringify(source)} },
          collapsed: false, onClose() {}, onToggleCollapse() {},
        }));
        window.renderReport();
      `, resolveDir: root, sourcefile: 'report-download-browser.tsx', loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
      alias: { react: join(root, 'web/node_modules/react'), 'react-dom': join(root, 'web/node_modules/react-dom') },
    });
    let failPdf = false;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url!, 'http://127.0.0.1');
        if (url.pathname === '/entry.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(compiled.outputFiles[0]!.text); }
        else if (url.pathname === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(await readFile('web/src/styles.css')); }
        else if (url.pathname === '/api/artifacts/report/download') {
          if (url.searchParams.get('format') === 'pdf') {
            if (failPdf) { failPdf = false; response.writeHead(500).end(); return; }
            response.setHeader('Content-Type', 'application/pdf');
            response.end(await createReportPdf(source, '季度研究报告.md'));
          } else {
            response.setHeader('Content-Type', 'text/markdown');
            response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('季度研究报告.md')}`);
            response.end(source);
          }
        } else { response.setHeader('Content-Type', 'text/html'); response.end('<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="height:100vh;display:flex;justify-content:flex-end"></div><script type="module" src="/entry.js"></script></body></html>'); }
      })().catch(error => response.writeHead(500).end(String(error)));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
      const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1100, height: 800 } });
      await page.goto(`http://127.0.0.1:${port}`);
      const toggle = page.getByRole('button', { name: '下载 ▾' });
      await toggle.click();
      await page.getByRole('link', { name: 'Markdown（原文）' }).waitFor();
      await toggle.press('Tab');
      expect(await page.getByRole('link', { name: 'Markdown（原文）' }).evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press('Escape');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('.artifact-preview-drawer').count()).toBe(1);
      await toggle.click();
      const mdDownload = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Markdown（原文）' }).click();
      const md = await mdDownload;
      expect(md.suggestedFilename()).toBe('季度研究报告.md');
      expect(await readFile((await md.path())!, 'utf8')).toBe(source);
      failPdf = true;
      await toggle.click();
      await page.getByRole('button', { name: 'PDF 文档' }).click();
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toContain('PDF 导出失败');
      await toggle.click();
      const pdfDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'PDF 文档' }).click();
      const pdf = await pdfDownload;
      expect(pdf.suggestedFilename()).toBe('季度研究报告.pdf');
      expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe('%PDF-');
      expect(await page.getByRole('alert').count()).toBe(0);

      await toggle.click();
      for (const [width, theme] of [[1100, 'dark'], [390, 'light']] as const) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // Theme colors animate; capture and compare after the transition settles.
        await page.waitForFunction(expected => getComputedStyle(document.querySelector('.artifact-download-options button')!).color === expected,
          theme === 'light' ? 'rgb(22, 24, 29)' : 'rgb(237, 241, 236)');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (process.env.REPORT_DOWNLOAD_SCREENSHOT_DIR) {
          await mkdir(process.env.REPORT_DOWNLOAD_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.REPORT_DOWNLOAD_SCREENSHOT_DIR, `menu-${theme}-${width}.png`) });
        }
      }

      // Exercise the shared UI's native branch independently of an installed account or app.
      await page.evaluate(() => {
        Object.assign(window, { nativeCalls: [], saveResult: null, metaworkDesktop: {
          version: 1,
          saveArtifact: async (...args: unknown[]) => { (window as any).nativeCalls.push(args); return (window as any).saveResult; },
          showDownloadedArtifact: async (id: string) => { (window as any).nativeCalls.push(['reveal', id]); },
        } });
        (window as any).renderReport('text'); (window as any).renderReport('markdown');
      });
      // Close any still-open Web menu, then select a native save.
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      await toggle.click();
      await page.getByRole('button', { name: 'PDF 文档' }).click();
      await toggle.waitFor();
      expect(await page.evaluate(() => (window as any).nativeCalls)).toEqual([['report', 'pdf']]);
      expect(await page.getByRole('alert').count()).toBe(0);
      expect(await page.getByRole('button', { name: '在 Finder 中显示' }).count()).toBe(0);
      await page.evaluate(() => { (window as any).saveResult = 'download-1'; });
      await toggle.click();
      await page.getByRole('button', { name: 'Markdown（原文）' }).click();
      await page.getByRole('button', { name: '在 Finder 中显示' }).click();
      expect(await page.evaluate(() => (window as any).nativeCalls)).toEqual([['report', 'pdf'], ['report', 'original'], ['reveal', 'download-1']]);
      await page.evaluate(() => { delete (window as any).metaworkDesktop; (window as any).renderReport('text'); });
      await page.getByRole('link', { name: '下载原文件' }).waitFor();
      expect(await page.getByRole('button', { name: '下载 ▾' }).count()).toBe(0);
    } finally {
      await browser.close();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    }
  });
});
