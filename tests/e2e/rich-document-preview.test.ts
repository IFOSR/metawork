import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { richDocumentFiles } from '../fixtures/rich-document-files.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { TaskArtifactRepo, hashContent } from '../../src/storage/task-artifact-repo.js';
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

describe.runIf(process.env.RUN_BROWSER_E2E === '1')('Rich document preview through production Server', () => {
  it('renders historical files, isolates HTML, navigates slides/sheets and previews uploaded attachments', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    const server = await startProductionObservationServer();
    const db = new Database(resolveAccountPaths('local-default', server.root).database);
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const consoleErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO tasks (id,title,goal,status,account_id,conversation_id,workspace_id,owner_planner_session_id,admitted_at,created_at,updated_at) VALUES ('preview-test', '文档预览验收', 'preview', 'succeeded', 'local-default', 'conv_acceptance_10', 'workspace_acceptance', 'conv_acceptance_10', ?, ?, ?)`).run(now, now, now);
      const files = await richDocumentFiles();
      const directory = join(server.workspace, 'metaclaw-tasks', 'preview-test'); await mkdir(directory, { recursive: true });
      const artifacts = new TaskArtifactRepo(db);
      const ids: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(files)) {
        const path = join(directory, name); await writeFile(path, bytes);
        ids[name] = artifacts.insert({ accountId: 'local-default', taskId: 'preview-test', displayName: name,
          relativePath: name, publishedPath: path, mediaType: 'application/octet-stream', previewKind: 'unsupported',
          contentHash: hashContent(bytes), byteLength: bytes.length, now }).artifactId;
      }
      const evidence = '.tmp/rich-preview-evidence'; await mkdir(evidence, { recursive: true });
      const open = async (name: string) => {
        await page.goto(`${server.endpoint.webOrigin}/#workspace=workspace_acceptance&conversation=conv_acceptance_10&artifact=${ids[name]}`);
        await page.locator('.rich-document-preview iframe').waitFor({ timeout: 30000 });
        return page.frameLocator('.rich-document-preview iframe');
      };
      const html = await open('report.html');
      const htmlPage = html.frameLocator('iframe');
      await htmlPage.getByText('HTML 商业报告').waitFor({ timeout: 15000 });
      expect(await htmlPage.locator('h1').evaluate(node => getComputedStyle(node).color)).toBe('rgb(36, 86, 166)');
      expect(await page.evaluate(() => document.body.dataset.previewEscaped)).toBeUndefined();
      expect(await htmlPage.locator('script').count()).toBe(0);
      expect(await htmlPage.getByAltText('本地图示').getAttribute('src')).toMatch(/^data:image\/png;base64,/u);
      await page.screenshot({ path: `${evidence}/html.png` });

      const word = await open('report.docx');
      await word.getByText('企业主权 AI 文档预览').waitFor({ timeout: 15000 });
      expect(await word.locator('table').textContent()).toContain('中文表格内容');
      expect(await word.locator('img').count()).toBeGreaterThan(0);
      expect(await word.locator('section.docx').count()).toBe(2);
      expect(await word.locator('section.docx').first().evaluate(node => node.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: `${evidence}/word.png` });

      const ppt = await open('slides.pptx');
      await ppt.getByText('商业宣讲第 1 页', { exact: true }).waitFor({ timeout: 15000 });
      expect(await ppt.locator('#controls').textContent()).toContain('1 / 3');
      await ppt.getByRole('button', { name: '下一页' }).click();
      await ppt.getByText('商业宣讲第 2 页', { exact: true }).waitFor();
      await page.screenshot({ path: `${evidence}/powerpoint.png` });

      const excel = await open('sales.xlsx');
      await excel.getByText('商业化收入', { exact: true }).waitFor({ timeout: 15000 });
      expect(await excel.locator('td[colspan="3"]').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(36, 86, 166)');
      expect(await excel.locator('table').textContent()).toContain('¥1,234.50');
      expect(await excel.locator('table').textContent()).toContain('2469');
      await page.screenshot({ path: `${evidence}/excel.png` });
      await excel.getByLabel('工作表', { exact: true }).selectOption('定价明细');
      await excel.getByText('每月 99 元', { exact: true }).waitFor();

      const legacy = await open('legacy.xls'); await legacy.getByText('旧版表格', { exact: true }).waitFor();
      const csv = await open('data.csv'); await csv.getByText('企业版', { exact: true }).waitFor();
      const pdf = await open('report.pdf'); await pdf.locator('canvas').waitFor();
      await pdf.getByText('页 1 / 1', { exact: true }).waitFor({ timeout: 15000 });
      expect(await pdf.locator('canvas').evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(100);
      await page.screenshot({ path: `${evidence}/pdf.png` });

      const broken = await open('broken.docx'); await broken.getByRole('alert').waitFor();
      expect(await broken.getByRole('alert').textContent()).toContain('无法预览');
      const download = await page.getByRole('link', { name: '下载原文件', exact: true }).getAttribute('href');
      const response = await page.request.get(`${server.endpoint.webOrigin}${download}`);
      expect(await response.body()).toEqual(files['broken.docx']);

      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles({ name: '上传文档.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: files['report.docx']! });
      await page.getByTitle('预览 上传文档.docx', { exact: true }).click({ timeout: 15000 });
      const uploaded = page.frameLocator('.rich-document-preview iframe');
      await uploaded.getByText('企业主权 AI 文档预览').waitFor({ timeout: 15000 });
      const attachmentLink = await page.getByRole('link', { name: '下载原文件', exact: true }).getAttribute('href');
      expect(attachmentLink).toContain('/api/attachments/');
      const attachmentResponse = await page.request.get(`${server.endpoint.webOrigin}${attachmentLink}`);
      expect(attachmentResponse.headers()['content-disposition']).toMatch(/^attachment;/u);
      expect(attachmentResponse.headers()['content-security-policy']).toContain('sandbox');
      expect(attachmentResponse.headers()['access-control-allow-origin']).toBeUndefined();
      expect((await fetch(`${server.endpoint.webOrigin}${attachmentLink}`)).status).toBe(401);
      await page.screenshot({ path: `${evidence}/attachment.png` });
      expect(pageErrors).toEqual([]);
      await writeFile(`${evidence}/result.json`, JSON.stringify({ formats: Object.keys(files), uploadedDocx: true, htmlIsolated: true, pageErrors, consoleErrors }, null, 2));
    } catch (error) {
      await mkdir('.tmp/rich-preview-evidence', { recursive: true });
      await page.screenshot({ path: '.tmp/rich-preview-evidence/failure.png' });
      await writeFile('.tmp/rich-preview-evidence/failure.json', JSON.stringify({ pageErrors, consoleErrors }, null, 2));
      throw error;
    } finally { await browser.close(); db.close(); await server.close(); }
  }, 180000);
});
