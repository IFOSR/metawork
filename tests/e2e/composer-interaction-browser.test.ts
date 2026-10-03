import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const acceptance = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;
acceptance('real browser Composer interactions', () => {
  it('preserves focus and Chinese draft during IME confirmation without sending twice', async () => {
    const bundle = await build({ stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: `
      import { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { Composer } from './src/components/Composer';
      import { MarkdownContent } from './src/components/MarkdownContent';
      const revoke=URL.revokeObjectURL; window.revokedImages=0;
      URL.revokeObjectURL=(url)=>{window.revokedImages++;revoke.call(URL,url);};
      function App() { const [draft,setDraft]=useState(''); const [sent,setSent]=useState(0); const [show,setShow]=useState(true);
        return <><output>{sent}</output><Composer draft={draft} disabled={false} running={false}
          attachments={[]} onDraftChange={setDraft} onSend={()=>setSent(v=>v+1)} onCancel={()=>{}}
          onFilesSelected={()=>{}} onRemoveAttachment={()=>{}} />
          <button id="hide-image" onClick={()=>setShow(false)}>关闭图片</button>
          {show && <MarkdownContent value="![一像素图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=)" />}</>; }
      createRoot(document.getElementById('root')).render(<App/>);` },
      bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const http = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/bundle.js' ? bundle.outputFiles[0]!.text
        : '<!doctype html><html lang="zh"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
    });
    await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser((http.address() as AddressInfo).port, 'composer-ime');
      await waitForExpression(browser.cdp, `Boolean(document.querySelector('[aria-label="会话消息"]'))`);
      await browser.cdp.evaluate(`document.querySelector('textarea').focus()`);
      await browser.cdp.send('Input.insertText', { text: '中文草稿' });
      expect(await browser.cdp.evaluate(`document.querySelector('textarea').value`)).toBe('中文草稿');
      expect(await browser.cdp.evaluate(`document.activeElement===document.querySelector('textarea')`)).toBe(true);
      await waitForExpression(browser.cdp, `document.querySelector('img[alt="一像素图片"]')?.naturalWidth===1`);
      expect(await browser.cdp.evaluate(`document.querySelector('img').src.startsWith('blob:')`)).toBe(true);
      await browser.cdp.evaluate(`document.querySelector('#hide-image').click()`);
      await waitForExpression(browser.cdp, `window.revokedImages===1 && !document.querySelector('img')`);
      await browser.cdp.evaluate(`(() => {const input=document.querySelector('textarea');
        input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中文'}));
        input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true,keyCode:229}));
        input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
        input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'}));})()`);
      expect(await browser.cdp.evaluate(`document.querySelector('output').textContent`)).toBe('0');
      await browser.cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitForExpression(browser.cdp, `document.querySelector('output').textContent==='1'`);
      expect(await browser.cdp.evaluate(`document.activeElement===document.querySelector('textarea')`)).toBe(true);
    } finally { await browser?.close(); await new Promise<void>(done => http.close(() => done())); }
  }, 30_000);
});
