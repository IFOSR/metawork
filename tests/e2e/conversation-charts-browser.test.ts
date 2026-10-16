import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';
import type { ConversationTurn as PresentedTurn } from '../../src/management/web-session-types.js';
import { TaskArtifactRepo, hashContent } from '../../src/storage/task-artifact-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
const fence = (spec: unknown) => `\n\n\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\`\n`;
const common = { version: 1, labels: ['一季度', '二季度', '三季度', 'Q4 & <预>'], unit: '万元', source: '验收数据 sales.csv（非实际经营数据）', xLabel: '季度' };
const series = [{ name: '收入', values: [120, 150, null, 190] }, { name: '利润', values: [-10, 20, 30, 45] }];
const answer = '## 季度经营分析（测试数据）\n\n| 季度 | 收入 | 利润 | 说明 | 数据文件 |\n| :--- | ---: | ---: | :---: | --- |\n'
  + '| 一季度 | 120 | -10 | A\\|B | sales.csv |\n| 二季度 | 150 | 20 | 转盈 | `sales.csv` |\n\n'
  + '收入上升，利润由负转正；三季度收入缺失，不将缺失值当作零。\n'
  + fence({ ...common, type: 'line', title: '收入与利润趋势', series })
  + fence({ ...common, type: 'bar', title: '季度收入对比', series })
  + fence({ ...common, type: 'area', title: '收入规模', series: [series[0]] })
  + fence({ ...common, type: 'pie', title: '产品收入占比', labels: ['企业版', '专业版', '基础版'], series: [{ name: '收入', values: [60, 30, 10] }] })
  + fence({ ...common, type: 'bar', title: '拒绝脚本', series, tooltip: { formatter: 'alert(1)' } })
  + '\n```chart\n{"version":\n```\n\n```js\nconst file = "sales.csv";\n```\n\n'
  + '<span data-markdown-slot="0">不可伪造插槽</span><img src="x" onerror="window.chartInjected=true"><script>window.chartInjected=true</script>\n';

describe.runIf(process.env.RUN_BROWSER_E2E === '1')('Conversation tables and charts through production Server', () => {
  it('renders persisted content, safe artifact references and offline interactive charts across themes and widths', async () => {
    const server = await startProductionObservationServer();
    const db = new Database(resolveAccountPaths('local-default', server.root).database);
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const external: string[] = [];
    page.on('request', request => { if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== server.endpoint.webOrigin) external.push(request.url()); });
    const evidence = '.tmp/conversation-charts-evidence'; await mkdir(evidence, { recursive: true });
    try {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO tasks(id,title,goal,status,account_id,conversation_id,workspace_id,owner_planner_session_id,admitted_at,created_at,updated_at)
        VALUES ('chart-test','图表验收','charts','done','local-default','conv_acceptance_10','workspace_acceptance','conv_acceptance_10',?,?,?)`).run(now, now, now);
      const directory = join(server.workspace, 'metaclaw-tasks', 'chart-test'); await mkdir(directory, { recursive: true });
      const path = join(directory, 'sales.csv'); const bytes = Buffer.from('季度,收入\n一季度,120\n'); await writeFile(path, bytes);
      const artifact = new TaskArtifactRepo(db).insert({ accountId: 'local-default', taskId: 'chart-test', displayName: 'sales.csv', relativePath: 'sales.csv',
        publishedPath: path, mediaType: 'text/csv', previewKind: 'text', contentHash: hashContent(bytes), byteLength: bytes.length, now });
      const turn: ConversationTurn = { id: 'turn_9', conversationId: 'conv_acceptance_10', userInput: '分析季度数据并展示表格和图表', status: 'completed', finalAnswer: answer };
      const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
      history.replace(turn.conversationId, [
        { ...turn, id: 'turn_7', userInput: '之前的问题', finalAnswer: '之前的结论。' },
        { ...turn, id: 'turn_8', userInput: '之前的数据', finalAnswer: '| 季度 | 收入 |\n| --- | ---: |\n| Q1 | 120 |' },
        turn,
      ]);
      const presentations = new SqliteConversationHistoryRepo<PresentedTurn>(db, 'local-default', 'presentation');
      presentations.importOnce(turn.conversationId, []);
      presentations.upsert(turn.conversationId, {
        ...turn, sessionId: turn.conversationId, taskId: 'chart-test', startedAt: now, completedAt: now,
        traceEvents: [], executionTimeline: null, artifactRefs: [artifact.artifactId], artifacts: [],
      });
      // Canonical text history intentionally does not carry Task identity. Seed
      // the same public Task association fact that a completed live Turn emits.
      const projector = new ConversationReadProjector(new SqliteConversationReadModel(db));
      projector.applyHistory('local-default', turn.conversationId, turn, 3);
      projector.apply('local-default', turn.conversationId, [{ protocolVersion: 2, eventId: 'chart-task-associated',
        sequence: 1, accountId: 'local-default', conversationId: turn.conversationId, turnId: turn.id,
        requestId: null, occurredAt: now, kind: 'trace_delta', payload: { taskId: 'chart-test', status: 'completed' },
      }], 1);
      const url = `${server.endpoint.webOrigin}/#workspace=workspace_acceptance&conversation=conv_acceptance_10&turn=turn_9`;
      await page.goto(url);
      const reply = page.locator('[data-observed-turn="turn_9"] .final-answer');
      await reply.locator('.inline-chart-plot svg').first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-observed-turn="turn_9"] .inline-chart-plot svg').length === 4);
      const table = reply.locator('.markdown-table-scroll table').first();
      expect(await table.locator('thead th').count()).toBe(5);
      expect(await table.locator('tbody tr').count()).toBe(2);
      expect(await table.locator('tbody tr').first().locator('td').nth(3).textContent()).toBe('A|B');
      expect(await table.locator('td').first().evaluate(node => getComputedStyle(node).borderRightWidth)).toBe('1px');
      expect(await table.locator('tbody tr').first().locator('td').nth(1).evaluate(node => getComputedStyle(node).textAlign)).toBe('right');
      await table.locator('[data-artifact-reference]').nth(1).waitFor();
      expect(await table.locator('[data-artifact-reference]').count()).toBe(2);
      expect(await reply.locator('pre code.language-js').textContent()).toContain('sales.csv');
      expect(await reply.locator('pre [data-artifact-reference]').count()).toBe(0);
      expect(await reply.locator('.inline-chart-source [data-artifact-reference]').count()).toBe(0);
      expect(await reply.locator('.inline-chart-fallback').count()).toBe(2);
      expect(await page.evaluate(() => (window as unknown as { chartInjected?: boolean }).chartInjected)).toBeUndefined();
      expect(await reply.locator('script, [onerror]').count()).toBe(0);
      const line = reply.getByRole('figure', { name: '收入与利润趋势', exact: true });
      const legend = line.getByRole('button', { name: '利润', exact: true });
      await legend.click(); expect(await legend.getAttribute('aria-pressed')).toBe('false');
      await legend.focus(); await page.keyboard.press('Enter'); expect(await legend.getAttribute('aria-pressed')).toBe('true');
      await line.locator('summary').click();
      expect(await line.getByRole('cell', { name: '缺失', exact: true }).count()).toBe(1);
      expect(await line.getByRole('cell', { name: '-10', exact: true }).count()).toBe(1);
      expect(await line.getByRole('cell', { name: '-10', exact: true }).evaluate(node => getComputedStyle(node).textAlign)).toBe('right');
      await line.locator('summary').click();
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      const plot = line.locator('.inline-chart-plot'); await plot.hover({ position: { x: 180, y: 100 } });
      expect(await plot.getAttribute('aria-label')).not.toContain('NaN');
      await page.waitForFunction(() => [...document.querySelectorAll('.inline-chart-plot svg')].some(node => node.textContent?.includes('利润')));
      const downloadPromise = page.waitForEvent('download'); await line.getByRole('button', { name: '下载 SVG' }).click();
      const download = await downloadPromise; await download.saveAs(`${evidence}/chart.svg`);
      const exportedSvg = await readFile(`${evidence}/chart.svg`, 'utf8');
      const exportedImage = await page.evaluate(async xml => {
        const parsed = new DOMParser().parseFromString(xml, 'image/svg+xml');
        if (parsed.querySelector('parsererror')) throw new Error('exported SVG is not valid XML');
        const image = new Image(); image.src = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(xml)}`;
        await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, png: canvas.toDataURL('image/png').startsWith('data:image/png;base64,'),
          text: parsed.documentElement.textContent };
      }, exportedSvg);
      expect(exportedImage.width).toBeGreaterThan(100); expect(exportedImage.height).toBeGreaterThan(100);
      expect(exportedImage.png).toBe(true); expect(exportedImage.text).toContain('Q4 & <预>');
      await line.screenshot({ path: `${evidence}/line-dark.png` });
      await table.screenshot({ path: `${evidence}/table.png` });
      await table.locator('[data-artifact-reference]').first().click();
      await page.locator('.rich-document-preview iframe').waitFor();
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await line.screenshot({ path: `${evidence}/line-light.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await table.scrollIntoViewIfNeeded();
      const scroll = reply.locator('.markdown-table-scroll').first();
      expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      await scroll.focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => [...document.querySelectorAll('.markdown-table-scroll')].some(node => node.scrollLeft > 0));
      const bounds = await line.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(390);
      expect(await plot.evaluate(node => Math.abs(node.clientWidth - node.querySelector('svg')!.getBoundingClientRect().width))).toBeLessThan(2);
      await line.screenshot({ path: `${evidence}/mobile.png` });
      await page.reload(); await reply.locator('.inline-chart-plot svg').first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-observed-turn="turn_9"] .inline-chart-plot svg').length === 4);
      // A new persisted answer replaces portals without stale charts or broken React ownership.
      history.upsert(turn.conversationId, { ...turn, finalAnswer: '| 更新 | 数值 |\n| --- | ---: |\n| 新值 | 9 |\n' });
      await reply.getByRole('cell', { name: '新值', exact: true }).waitFor();
      expect(await reply.locator('.inline-chart').count()).toBe(0);
      expect(external).toEqual([]); expect(errors).toEqual([]);
      await writeFile(`${evidence}/result.json`, JSON.stringify({ table: true, artifactCell: true, chartTypes: ['line', 'bar', 'area', 'pie'],
        missingAndNegative: true, legendKeyboard: true, svgExport: true, svgImageDecode: true, malformedFallback: true, mobile: true, themes: true, reload: true, external, errors }, null, 2));
    } catch (error) {
      await page.screenshot({ path: `${evidence}/failure.png` });
      await writeFile(`${evidence}/failure.html`, await page.content());
      await writeFile(`${evidence}/failure.txt`, `${String(error)}\n${errors.join('\n')}`); throw error;
    } finally { await browser.close(); db.close(); await server.close(); }
  }, 180000);
});
