import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { startProductionObservationServer } from '../fixtures/production-observation-server.js';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const enabled = process.env.RUN_OBSERVATION_SOAK === '1' ? describe : describe.skip;
enabled('production observation continuous update soak', () => {
  it('keeps live updates, switching, DOM and browser heap bounded for 30 minutes', async () => {
    const server = await startProductionObservationServer();
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser(server.port, 'observation-soak');
      const cdp = browser.cdp;
      await waitForExpression(cdp, `location.origin === 'http://127.0.0.1:${server.port}' && document.readyState === 'complete'`);
      await cdp.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'acceptance',password:'fixture-password'})})`);
      await cdp.send('Page.reload');
      await waitForExpression(cdp, `Boolean(document.querySelector('#workspace-select option[value="workspace_acceptance"]'))`);
      await cdp.evaluate(`(()=>{const s=document.querySelector('#workspace-select');s.value='workspace_acceptance';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitForExpression(cdp, `document.querySelectorAll('.session-row').length===3`);
      await cdp.send('Performance.enable');
      const start = Date.now(); const heap: number[] = []; let revision = 0;
      while (Date.now() - start < 30 * 60 * 1000) {
        const size = [10, 100, 1000][revision % 3]!;
        server.updateLatest(size, revision);
        await cdp.evaluate(`[...document.querySelectorAll('.session-row')].find(row=>row.innerText.split('\\n')[0]==='History ${size}').click()`);
        await waitForExpression(cdp, `document.querySelector('[data-observed-turn="turn_${size - 1}"]')?.innerText.includes('UPDATE_${revision}')`, 30000);
        expect(await cdp.evaluate(`document.querySelectorAll('.conversation-turn').length`)).toBeLessThanOrEqual(40);
        if (revision % 30 === 0) {
          await cdp.send('HeapProfiler.collectGarbage');
          const metrics = await cdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> };
          const used = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value;
          heap.push(used);
          expect(used).toBeLessThan(96 * 1024 * 1024);
          console.log('soak checkpoint', { elapsedSeconds: Math.round((Date.now() - start) / 1000), revision, heapBytes: used });
        }
        revision++; await delay(1000);
      }
      expect(heap.at(-1)! - heap[1]!).toBeLessThan(16 * 1024 * 1024);
      console.log('soak completed', { durationMs: Date.now() - start, updates: revision, heap });
    } finally {
      await browser?.close(); await server.close();
    }
  }, 32 * 60 * 1000);
});
