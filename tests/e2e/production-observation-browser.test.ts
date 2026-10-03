import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const e2e = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

e2e('production Server observation browser acceptance', () => {
  it('authenticates and browses 10/100/1000 Turns through the built Server and Web', async () => {
    const server = await startProductionObservationServer();
    const browser = await launchBrowser(server.port, 'production-observation');
    try {
      await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__requests=[];const originalFetch=window.fetch;
        window.fetch=async(...args)=>{const response=await originalFetch(...args);
          if(String(args[0]).includes('/api/workspaces'))window.__requests.push({url:String(args[0]),status:response.status,body:await response.clone().text()});
          return response;};` });
      await waitForExpression(browser.cdp, `location.origin === 'http://127.0.0.1:${server.port}' && document.readyState === 'complete'`);
      await browser.cdp.evaluate(`fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'acceptance',password:'fixture-password'})}).then(r=>{if(!r.ok)throw new Error('login '+r.status)})`);
      await browser.cdp.send('Page.reload');
      await waitForExpression(browser.cdp, `Boolean(document.querySelector('#workspace-select option[value=\"workspace_acceptance\"]'))`);
      await browser.cdp.evaluate(`(() => {const select=document.querySelector('#workspace-select');
        select.value='workspace_acceptance';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForExpression(browser.cdp, `document.querySelectorAll('.session-row').length === 3`);
      for (const size of [10, 100, 1000]) {
        await browser.cdp.evaluate(`[...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\\n')[0]==='History ${size}').click()`);
        await waitForExpression(browser.cdp, `document.body.innerText.includes('RESULT_${size}')`, 30_000);
      }
      const baselineReads = server.measurements.filter(item => item.event === 'observation_diagnostics'
        && item.stages.conversation_turn_read);
      expect(baselineReads.length).toBeGreaterThanOrEqual(3);
      for (const read of baselineReads) {
        expect(read.stages.conversation_turn_read!.items).toBeLessThanOrEqual(20);
        expect(read.stages.conversation_turn_read!.bytes).toBeLessThanOrEqual(256 * 1024);
        expect(read.stages.journal_segment_read?.bytes ?? 0).toBe(0);
        expect(read.stages.conversation_content_read?.bytes ?? 0).toBe(0);
      }
      console.log('production baseline Storage reads', JSON.stringify(baselineReads.map(item => item.stages)));
      const samples = await browser.cdp.evaluate(`(async()=>{
        const samples=[];
        for(let i=0;i<100;i++){
          const size=[10,100,1000][i%3]; const start=performance.now();
          [...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\\n')[0]==='History '+size).click();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          if(!document.body.innerText.includes('RESULT_'+size))throw new Error('wrong Conversation '+i);
          samples.push(performance.now()-start);
        }
        return samples.sort((a,b)=>a-b);
      })()`) as number[];
      console.log('production observation warm switch ms', JSON.stringify({ n: samples.length,
        p50: samples[49], p95: samples[94], p99: samples[98] }));
      expect(samples[94]).toBeLessThan(100);
      const mountedTurns = await browser.cdp.evaluate(`document.querySelectorAll('.conversation-turn').length`) as number;
      expect(mountedTurns).toBeGreaterThan(0);
      expect(mountedTurns).toBeLessThanOrEqual(40);
      const historyRequests = await browser.cdp.evaluate(`performance.getEntriesByType('resource')
        .filter(r=>['history','attach'].some(part=>new URL(r.name).pathname.endsWith('/'+part))).map(r=>r.name)`);
      expect(historyRequests).toEqual([]);
      // The transcript keeps its original layout. Search remains a resource;
      // deep links locate old Turns and their full content loads without a button.
      expect(await browser.cdp.evaluate(`!document.body.innerText.includes('搜索会话历史') && !document.body.innerText.includes('阅读完整结果')`)).toBe(true);
      await browser.cdp.evaluate(`location.hash='workspace=workspace_acceptance&conversation=conv_acceptance_10&turn=turn_0'`);
      await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_0"]')?.innerText.includes('SEARCH_BEYOND_PREVIEW')`);
      await browser.cdp.evaluate(`[...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\\n')[0]==='History 100').click()`);
      await waitForExpression(browser.cdp, `document.body.innerText.includes('RESULT_100')`);
      await browser.cdp.evaluate(`history.back()`);
      await waitForExpression(browser.cdp, `location.hash.includes('conv_acceptance_10') && document.querySelector('.session-row.is-selected')?.innerText.includes('History 10') || location.hash.includes('conv_acceptance_10') && document.body.innerText.includes('Question 10/')`);
      await browser.cdp.evaluate(`location.hash='workspace=workspace_acceptance&conversation=conv_acceptance_100&turn=turn_99'`);
      await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_99"]')?.innerText.includes('RESULT_100')`);
      const deepLinkDocument = await browser.cdp.evaluate('performance.timeOrigin');
      await browser.cdp.send('Page.reload');
      await waitForExpression(browser.cdp, `performance.timeOrigin !== ${deepLinkDocument}`);
      await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_99"]')?.innerText.includes('RESULT_100')`);
      // Fresh document/entity cache with a 100 ms / 10 Mbps network profile.
      // This includes the bundle/navigation handshake, not only an API response.
      await browser.cdp.send('Network.enable');
      await browser.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100,
        downloadThroughput: 10_000_000 / 8, uploadThroughput: 10_000_000 / 8 });
      const oldDocument = await browser.cdp.evaluate('performance.timeOrigin');
      const remoteStart = performance.now();
      await browser.cdp.send('Page.reload', { ignoreCache: true });
      await waitForExpression(browser.cdp, `performance.timeOrigin !== ${oldDocument}`);
      await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_99"]')?.innerText.includes('RESULT_100')`, 6000);
      const remoteCold = performance.now() - remoteStart;
      console.log('production remote cold document ms', remoteCold);
      expect(remoteCold).toBeLessThan(3000);
      // Selection survives an update to another Turn, including virtualization.
      const selected = await browser.cdp.evaluate(`(() => {
        const element=document.querySelector('[data-observed-turn="turn_99"] .markdown-content');
        if(!element)throw new Error('result text missing');
        const range=document.createRange();range.selectNodeContents(element);
        getSelection().removeAllRanges();getSelection().addRange(range);
        return getSelection().toString();
      })()`);
      expect(selected).toContain('RESULT_100');
      server.updateLatest(10, 9999);
      await browser.cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      expect(await browser.cdp.evaluate(`getSelection().toString()`)).toBe(selected);
      await browser.cdp.evaluate(`getSelection().removeAllRanges()`);
      const remoteSamples: number[] = [];
      for (let n = 0; n < 10; n++) {
        await browser.cdp.evaluate(`history.replaceState(null,'','#workspace=workspace_acceptance&conversation=conv_acceptance_100')`);
        const previousDocument = await browser.cdp.evaluate('performance.timeOrigin');
        await browser.cdp.send('Page.reload');
        await waitForExpression(browser.cdp, `performance.timeOrigin !== ${previousDocument}`);
        await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_99"]')?.innerText.includes('RESULT_100')`);
        const size = n % 2 ? 10 : 1000;
        const started = performance.now();
        await browser.cdp.evaluate(`[...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\\n')[0]==='History ${size}').click()`);
        await waitForExpression(browser.cdp, `document.querySelector('[data-observed-turn="turn_${size - 1}"]')?.innerText.includes('RESULT_${size}')`);
        remoteSamples.push(performance.now() - started);
      }
      remoteSamples.sort((a, b) => a - b);
      console.log('production remote cold Conversation ms', { n: remoteSamples.length, p50: remoteSamples[4], p95: remoteSamples[9] });
      expect(remoteSamples[9]).toBeLessThan(1000);
    } catch (error) {
      console.log('navigation requests', await browser.cdp.evaluate('window.__requests'));
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  }, 90_000);
});
