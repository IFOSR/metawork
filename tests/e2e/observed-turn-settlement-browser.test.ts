import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const e2e = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

e2e('historical running Turn browser recovery', () => {
  it('removes Stop through production WebSocket patches and after reloading a stale historical projection', async () => {
    const server = await startProductionObservationServer();
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser(server.port, 'turn-settlement');
      await waitForExpression(browser.cdp, `location.origin === 'http://127.0.0.1:${server.port}' && document.readyState === 'complete'`);
      await browser.cdp.evaluate(`fetch('/api/auth/session').then(r=>{if(!r.ok)throw new Error('session '+r.status)})`);
      await browser.cdp.send('Page.reload');
      await waitForExpression(browser.cdp, `Boolean(document.querySelector('#workspace-select option[value="workspace_acceptance"]'))`);
      await browser.cdp.evaluate(`(() => {const select=document.querySelector('#workspace-select');
        select.value='workspace_acceptance';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForExpression(browser.cdp, `document.querySelectorAll('.session-row:not(:disabled)').length === 3`);
      await browser.cdp.evaluate(String.raw`[...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\n')[0]==='History 10').click()`);
      await waitForExpression(browser.cdp, `document.body.innerText.includes('RESULT_10')`);

      // Only this disposable fixture is changed. Emulate the historical
      // rejected command: no Task, raw running projection, then a reply time.
      const db = new Database(resolveAccountPaths('local-default', server.root).database);
      try {
        const model = new SqliteConversationReadModel(db);
        const current = model.findTurn('local-default', 'conv_acceptance_10', 'turn_9')!;
        const running = { ...current, status: 'running' as const, taskId: null,
          interactionKind: 'system_command' as const, completedAt: null };
        model.commit('local-default', 'conv_acceptance_10', [running],
          model.head('local-default', 'conv_acceptance_10')!.journalSequence);
        await waitForExpression(browser.cdp, `Boolean(document.querySelector('.stop-button'))`);
        const completed = { ...model.findTurn('local-default', 'conv_acceptance_10', 'turn_9')!,
          completedAt: new Date().toISOString() };
        model.commit('local-default', 'conv_acceptance_10', [completed],
          model.head('local-default', 'conv_acceptance_10')!.journalSequence);
        await waitForExpression(browser.cdp, `!document.querySelector('.stop-button')`);
        expect(model.findTurn('local-default', 'conv_acceptance_10', 'turn_9')?.status).toBe('running');

        const origin = await browser.cdp.evaluate('performance.timeOrigin');
        await browser.cdp.send('Page.reload');
        await waitForExpression(browser.cdp, `performance.timeOrigin !== ${origin} && document.body.innerText.includes('RESULT_10')`);
        // Wait beyond observation polling so a raw baseline cannot restore Stop.
        await browser.cdp.evaluate(`new Promise(resolve=>setTimeout(resolve,750))`);
        expect(await browser.cdp.evaluate(`Boolean(document.querySelector('.stop-button'))`)).toBe(false);
      } finally { db.close(); }
    } finally {
      await browser?.close();
      await server.close();
    }
  }, 90_000);
});
