import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

// A separate ordinary browser, with its own cookie jar and explicit login.
// It watches the same installed Server and tasks as the packaged Desktop.
export async function packagedBrowser({ installRoot, evidence, env }) {
  const endpoint = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8'));
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true, env });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const report = { passed: false, ordinaryBrowser: true, serverPid: endpoint.pid };
  let conversationUrl;
  const turn = marker => page.locator('.conversation-turn').filter({ hasText: marker }).first();
  return {
    async workspace({ workspace, conversationId, workspaceId }) {
      const node = join(installRoot, 'app/current/desktop-tools/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
      const { stdout } = await promisify(execFile)(node,
        [join(installRoot, 'app/current/dist/index.js'), 'web', '--conversation', conversationId, '--no-open'],
        { cwd: workspace, env, timeout: 30000 });
      const launch = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#launch=[^\s]+/u)?.[0];
      assert.ok(launch, 'Installed web command did not provide a launch URL');
      assert.equal(new URL(launch).origin, endpoint.webOrigin);
      await page.goto(launch);
      await page.locator('.token-gate').waitFor();
      assert.equal(await page.evaluate(async () => (await fetch('/api/auth/session')).status), 401);
      assert.equal(await page.evaluate(() => typeof window.metaworkDesktop), 'undefined');
      report.desktopSessionDidNotAuthenticateBrowser = true;
      await page.locator('input[autocomplete=username]').fill(env.ANYFUSION_WEB_USERNAME);
      await page.locator('input[autocomplete=current-password]').evaluate((input, password) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, password);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, env.ANYFUSION_WEB_PASSWORD);
      await page.locator('.token-gate button[type=submit]').click();
      await page.locator('.workspace-shell').waitFor({ timeout: 30000 });
      report.explicitLogin = true;
      conversationUrl = `${endpoint.webOrigin}/#${new URLSearchParams({ workspace: workspaceId, conversation: conversationId })}`;
      await page.goto(conversationUrl);
      await page.locator('.composer textarea').waitFor();
    },
    async artifact({ marker, taskId }) {
      await turn(marker).locator('.execution-status-line[data-status=completed]').waitFor({ timeout: 60000 });
      await turn(marker).locator('.artifact-link').filter({ hasText: 'smoke-result.md' }).first().click();
      const link = page.locator('.artifact-drawer-download');
      await link.waitFor();
      const downloadUrl = await link.getAttribute('href');
      assert.equal((await fetch(new URL(downloadUrl, endpoint.webOrigin))).status, 401);
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      assert.equal((await readFile(await download.path(), 'utf8')).trim(), marker);
      report.artifactTaskId = taskId;
      report.authenticatedDownloadVerified = true;
      await page.screenshot({ path: join(evidence, 'browser-artifact.png') });
      await page.locator('.artifact-drawer-close').click();
    },
    async running({ marker, taskId }) {
      await turn(marker).locator('.execution-status-line[data-status=running]').waitFor({ timeout: 60000 });
      report.sameRunningTaskObserved = taskId;
    },
    async cancelled({ marker, taskId }) {
      await turn(marker).locator('.execution-status-line[data-status=cancelled]').waitFor({ timeout: 60000 });
      await page.reload();
      await turn(marker).locator('.execution-status-line[data-status=cancelled]').waitFor({ timeout: 60000 });
      assert.equal(JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid, endpoint.pid);
      report.cancelledTaskId = taskId;
      report.historyRestoredAfterReload = true;
      report.serverInstancePreserved = true;
      report.passed = true;
      await page.screenshot({ path: join(evidence, 'browser-cancelled.png') });
    },
    async close() {
      try { await browser.close(); }
      finally { await writeFile(join(evidence, 'ordinary-browser.json'), JSON.stringify(report, null, 2)); }
    },
  };
}
