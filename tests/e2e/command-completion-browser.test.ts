import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

describe.runIf(process.env.RUN_BROWSER_E2E === '1')('Desktop/Web shared command completion', () => {
  it('completes a historical conversation without starting Planner and preserves keyboard, IME and draft semantics', async () => {
    const { chromium } = desktopRequire('playwright-core') as typeof import('../../apps/desktop/node_modules/playwright-core');
    const server = await startProductionObservationServer();
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const commands: Array<{ kind: string; text?: string; cursor?: number }> = [];
    page.on('websocket', socket => socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.envelope?.command) commands.push(message.envelope.command);
      } catch { /* Non-JSON transport frames have no command. */ }
    }));
    await page.addInitScript(() => {
      // Delay selected replies at the transport boundary to exercise stale UI responses.
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        private texts = new Map<string, string>();
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string') {
            try {
              const envelope = JSON.parse(data).envelope;
              if (envelope?.command.kind === 'complete_command') this.texts.set(envelope.requestId, envelope.command.text);
            } catch { /* Ignore unrelated frames. */ }
          }
          super.send(data);
        }
        override set onmessage(handler: ((this: WebSocket, event: MessageEvent) => unknown) | null) {
          super.onmessage = handler ? event => {
            const reply = JSON.parse(event.data).event;
            const delayed = reply?.kind === 'command_completion' && this.texts.get(reply.requestId) === '/task';
            if (delayed) setTimeout(() => handler.call(this, event), 700);
            else handler.call(this, event);
          } : null;
        }
      };
    });
    try {
      await page.goto(`${server.endpoint.webOrigin}/#workspace=workspace_acceptance&conversation=conv_acceptance_10`);
      const input = page.getByRole('textbox', { name: '会话消息' });
      await input.waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('.composer textarea')?.disabled);
      await input.fill('/');
      const options = page.getByRole('listbox', { name: '指令联想' }).getByRole('option');
      await options.filter({ hasText: '/task' }).waitFor();
      expect(await options.count()).toBe(3);
      expect(commands.some(command => command.kind === 'complete_command' && command.text === '/')).toBe(true);
      await input.press('Enter');
      expect(await input.inputValue()).toBe('/task ');
      await options.filter({ hasText: 'list' }).first().waitFor();
      await input.fill('/task');
      await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('正在查找'));
      // Wait until the debounce has emitted the request, then edit before its delayed reply.
      await expect.poll(() => commands.some(command => command.kind === 'complete_command' && command.text === '/task'), { timeout: 3000 }).toBe(true);
      await input.press('Enter');
      expect(await input.inputValue()).toBe('/task');
      expect(commands.some(command => command.kind === 'slash_command')).toBe(false);
      await input.fill('/config');
      await options.filter({ hasText: '/config' }).waitFor();
      await page.waitForTimeout(850);
      expect(await options.allTextContents()).toEqual([expect.stringContaining('/config')]);
      await input.fill('/ta');
      await options.filter({ hasText: '/task' }).waitFor();
      await input.press('Enter'); expect(await input.inputValue()).toBe('/task ');
      await options.filter({ hasText: 'show' }).first().waitFor();
      await options.filter({ hasText: 'show' }).first().click();
      expect(await input.inputValue()).toBe('/task show ');
      await input.fill('/task list');
      await options.filter({ hasText: 'list' }).first().waitFor();
      await input.press('Escape'); expect(await options.count()).toBe(0);
      expect(await input.inputValue()).toBe('/task list');
      await input.fill('/'); await options.filter({ hasText: '/task' }).waitFor();
      await input.evaluate(node => {
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      expect(await input.inputValue()).toBe('/');
      await options.filter({ hasText: '/task' }).waitFor();
      await input.press('Shift+Enter'); expect(await input.inputValue()).toBe('/\n');
      expect(await options.count()).toBe(0);
      await input.fill('/'); await options.filter({ hasText: '/task' }).waitFor();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await mkdir('.tmp/command-completion-evidence', { recursive: true });
        await page.locator('.command-completion').screenshot({ path: `.tmp/command-completion-evidence/${theme}.png` });
        expect(await page.locator('.command-completion').evaluate(node => {
          const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
        })).toBe(true);
      }
      const previousRequests = commands.filter(command => command.text === '/task').length;
      await input.fill('/task');
      await expect.poll(() => commands.filter(command => command.text === '/task').length, { timeout: 3000 }).toBeGreaterThan(previousRequests);
      await page.locator('.session-row').filter({ has: page.getByText('History 100', { exact: true }) }).click();
      await expect.poll(() => input.inputValue()).toBe('');
      await page.waitForTimeout(850);
      expect(await options.count()).toBe(0);
      await input.fill('/'); await options.filter({ hasText: '/task' }).waitFor();
      await page.getByRole('button', { name: /新建会话/u }).click();
      await expect.poll(() => input.inputValue()).toBe('');
      await input.fill('/'); await options.filter({ hasText: '/task' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.locator('.command-completion').evaluate(node => {
        const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
      })).toBe(true);
      await page.screenshot({ path: '.tmp/command-completion-evidence/narrow.png' });
      expect(commands.filter(command => !command.kind.startsWith('get_') && command.kind !== 'complete_command')).toEqual([]);
      const db = new Database(resolveAccountPaths('local-default', server.root).database, { readonly: true });
      try { expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 }); }
      finally { db.close(); }
      await input.fill('/help');
      await input.press('Control+Enter');
      await expect.poll(() => commands.some(command => command.kind === 'slash_command' && command.text === '/help')).toBe(true);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await server.close(); }
  });
});
