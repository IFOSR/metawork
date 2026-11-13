import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';

const browserTests = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;
browserTests('debug', () => {
  it('debug task view', async () => {
    const server = await startProductionObservationServer();
    const db = new Database(resolveAccountPaths('local-default', server.root).database);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id,title,goal,status,account_id,conversation_id,workspace_id,owner_planner_session_id,admitted_at,created_at,updated_at) VALUES ('state-test', '可靠性状态验收', 'state test', 'needs_action', 'local-default', 'conv_acceptance_10', 'workspace_acceptance', 'conv_acceptance_10', ?, ?, ?)`).run(now, now, now);
    const revision = db.prepare('SELECT revision_id FROM configuration_revisions ORDER BY imported_at DESC LIMIT 1').get() as { revision_id: string };
    db.prepare(`INSERT INTO work_graph_revisions (id,task_id,revision,generation_id,proposal_source,automatic_replan,status,configuration_revision,created_at,updated_at) VALUES ('state-test-graph','state-test',1,'generation-state-test','initial',0,'active',?,?,?)`).run(revision.revision_id, now, now);
    db.prepare(`INSERT INTO subtasks (id,task_id,title,goal,status,required_capabilities_json,executor_bindings_json,delivery_kind,created_at,updated_at,graph_revision,generation_id) VALUES ('state-test-sub', 'state-test', '剩余工作', 'continue remaining work', 'ready', '[]', '[]', 'report', ?, ?, 1, 'generation-state-test')`).run(now, now);
    const browser = await launchBrowser(server.port, 'debug-task');
    try {
      await browser.cdp.send('Runtime.enable');
      await browser.cdp.send('Log.enable');
      await browser.cdp.send('Network.enable');
      const failures: string[] = [];
      const consoleMessages: string[] = [];
      browser.cdp.onEvent((method: string, params: any) => {
        if (method === 'Network.responseReceived' && params.response.status >= 400) {
          failures.push(`${params.response.status} ${params.response.url}`);
        }
        if (method === 'Runtime.consoleAPICalled') {
          consoleMessages.push(`${params.type}: ${params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
        }
      });
      await waitForExpression(browser.cdp, `Boolean(document.querySelector('#workspace-select option[value="workspace_acceptance"]'))`);
      await browser.cdp.evaluate(`(() => {const s=document.querySelector('#workspace-select'); s.value='workspace_acceptance';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForExpression(browser.cdp, `document.querySelectorAll('.session-row').length === 3`);
      await waitForExpression(browser.cdp, `[...document.querySelectorAll('.session-row')].every(r => !r.disabled)`);
      const clicked = await browser.cdp.evaluate(`(() => { const r = [...document.querySelectorAll('.session-row')].find(r=>r.innerText.trim().startsWith('History 10')); r.click(); return r.innerText; })()`);
      console.log('CLICKED:', clicked);
      await new Promise(r => setTimeout(r, 4000));
      const body = await browser.cdp.evaluate(`document.body.innerText`) as string;
      console.log('BODY:', body.slice(0, 1200));
      console.log('HAS-TASK:', body.includes('可靠性状态验收'), 'HAS-RESUME:', body.includes('继续未完成部分'));
      console.log('FAILURES:', failures.slice(0, 20));
      console.log('CONSOLE:', consoleMessages.slice(0, 20));
      const tasks = await browser.cdp.evaluate(`fetch('/api/conversations/conv_acceptance_10/view/activity').then(r => r.text())`) as string;
      console.log('API ACTIVITY IN BROWSER:', tasks.slice(0, 1500));
      const view = await fetch(`http://127.0.0.1:${server.port}/api/conversations/conv_acceptance_10/view/activity`).then(r => r.text()).catch(e => String(e));
      console.log('ACTIVITY:', view.slice(0, 800));
      expect(tasks).toContain('state-test');
    } finally { db.close(); await browser.close(); await server.close(); }
  }, 60_000);
});
