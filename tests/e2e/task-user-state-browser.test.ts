import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';

const browserTests = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;
browserTests('Task primary state through production Server and browser', () => {
  it('renders a needs-action Task, keeps input available and survives reconnect', async () => {
    const server = await startProductionObservationServer();
    const db = new Database(resolveAccountPaths('local-default', server.root).database);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks(id,title,goal,status,account_id,conversation_id,workspace_id,owner_planner_session_id,admitted_at,created_at,updated_at)
      VALUES ('state-test','可靠性状态验收','state test','blocked','local-default','conv_acceptance_10','workspace_acceptance','conv_acceptance_10',?,?,?)`).run(now, now, now);
    const browser = await launchBrowser(server.port, 'task-state');
    try {
      await waitForExpression(browser.cdp, `Boolean(document.querySelector('#workspace-select option[value="workspace_acceptance"]'))`);
      await browser.cdp.evaluate(`(() => {const s=document.querySelector('#workspace-select'); s.value='workspace_acceptance';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForExpression(browser.cdp, `document.querySelectorAll('.session-row').length === 3`);
      await browser.cdp.evaluate(`[...document.querySelectorAll('.session-row')].find(r=>r.innerText.includes('History 10')&&!r.innerText.includes('History 100')).click()`);
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        await waitForExpression(browser.cdp, `document.body.innerText.includes('可靠性状态验收') && document.body.innerText.includes('继续未完成部分')`);
        const summary = JSON.parse((db.prepare('SELECT body_json FROM conversation_activity_views WHERE task_id = ?').get('state-test') as { body_json: string }).body_json);
        expect(summary.userState).toBe('needs_action');
        expect(summary.userStateReason).toBeTruthy();
        expect(await browser.cdp.evaluate(`Boolean(document.querySelector('button[type="submit"]:not(:disabled)'))`)).toBe(true);
        if (reconnect === 0) await browser.cdp.send('Page.reload');
      }
    } finally { db.close(); await browser.close(); await server.close(); }
  });
});
