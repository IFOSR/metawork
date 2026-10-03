import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { launchBrowser, waitForExpression } from '../helpers/chrome-browser.js';

const acceptance = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;
acceptance('Conversation presentation with observation resources', () => {
  it('keeps execution cards, automatically displays the complete answer, report and bill, and fences late resources', async () => {
    const bundle = await build({ stdin: { resolveDir: resolve('web'), loader: 'tsx', contents: String.raw`
      import { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { ConversationEntityStore } from './src/observation/conversation-store';
      import { ObservedConversationView } from './src/observation/ObservedConversationView';
      const store=new ConversationEntityStore();
      const memory={anchors:new Map(),heights:new Map()};
      let status='running', step='正在检索公开资料', rev=1, bodyHash='a'.repeat(64);
      const answer='# 研究报告\n\n'+('正文内容🙂'.repeat(4000))+'\n\n**报告结尾：完整结果自动显示**';
      const body=new TextEncoder().encode(answer);window.bodyRequests=[];
      const summary=(conversationId='a')=>({id:'turn',conversationId,requestId:'req',revision:rev,firstSequence:1,lastSequence:rev,
        userInput:conversationId==='a'?'生成一份研究报告':'其他会话',userInputRef:null,answer:status==='completed'&&conversationId==='a'?'# 研究报告':'' ,
        answerRef:status==='completed'&&conversationId==='a'?{hash:bodyHash,byteLength:body.length}:null,
        resultId:null,certification:null,completeness:null,resultOffset:0,resultPreviewOmitted:false,status:conversationId==='a'?status:'completed',
        deliveryStatus:status==='completed'?'ready':'none',taskId:conversationId==='a'?'task':null,startedAt:new Date().toISOString(),completedAt:null,interactionKind:'ai_turn'});
      const baseline=(id)=>store.baseline(id,{head:{epoch:'epoch',revision:rev,journalSequence:rev},turns:[summary(id)],nextCursor:null});
      baseline('a');baseline('b');
      const artifact={artifactId:'report',taskId:'task',displayName:'研究报告.md',relativePath:'reports/research.md',
        previewKind:'markdown',byteLength:body.length,mimeType:'text/markdown',publishedAt:new Date().toISOString()};
      const event=()=>({id:'progress',eventKey:'progress',sequence:rev,occurredAt:new Date().toISOString(),phase:'execution',actor:'executor',
        kind:'executor_progress',status,taskId:'task',subtaskId:'subtask',title:step,summary:step,
        details:{subtaskTitle:'检索并生成研究报告',executorDisplayName:'Research',harnessDisplayName:'Codex',providerDisplayName:'Provider',modelDisplayName:'Model',stepLabel:step}});
      const ws={conversations:store,observations:{latest:()=>{}},query:async(id,command)=>{
        if(window.defer&&id==='a')await new Promise(done=>(window.pending??=[]).push(done));
        if(command.kind==='get_task_view')return {targetConversationId:id,turnId:'turn',taskId:'task',timeline:{taskId:'task',title:'研究报告',status,
          stages:[{phase:'execution',subtasks:[{id:'subtask',title:'检索并生成研究报告',status,executor:'Research',harnessDisplayName:'Codex',providerDisplayName:'Provider',modelDisplayName:'Model',attempts:[]}]}]},
          artifacts:status==='completed'?[artifact]:[]};
        if(command.kind==='get_query_bill_for_turn')return {turnId:'turn',turnBill:{turnId:'turn',conversationId:id,taskId:id==='a'?'task':null,queryId:'query_'+id,
          userStatus:'billed',amountMicroCoin:id==='a'?'0.25':'0.01',amountIsFinal:true,diagnosticCode:null,diagnosticMessage:null,usageBreakdown:[],stageBreakdown:[]}};
        throw new Error('Unexpected query');
      }};
      const http={getConversationTrace:async(id,turn,cursor,latest)=>{if(!latest)throw new Error('Card must read recent progress');return {events:id==='a'?[event()]:[],nextCursor:null}},
        getConversationContent:async(id,hash,offset,signal)=>{
          window.bodyRequests.push({id,offset});
          if(window.deferBody)await new Promise(done=>(window.pending??=[]).push(done));
          if(signal?.aborted)throw new Error('aborted');
          let end=Math.min(body.length,offset+32768);
          while(end<body.length&&(body[end]&0xc0)===0x80)end--;
          return {text:new TextDecoder().decode(body.slice(offset,end)),nextOffset:end,byteLength:body.length};
        }};
      window.progress=()=>{step='已找到资料，正在整理报告';rev++;baseline('a')};
      window.complete=()=>{status='completed';rev++;baseline('a')};
      window.refresh=()=>{rev++;baseline('a')};
      window.invalidateBody=()=>{bodyHash='b'.repeat(64);rev++;baseline('a')};
      window.release=()=>{window.defer=false;window.deferBody=false;for(const done of window.pending??[])done();window.pending=[]};
      function App(){const [id,setId]=useState('a');window.choose=setId;
        return <main className="workspace-canvas" style={{height:'95vh',overflow:'auto',padding:32}}>
          <ObservedConversationView key={id} conversationId={id} ws={ws} http={http} memory={memory}
            onOpenArtifact={value=>window.openedArtifact=value.artifactId}
            onOpenSubtaskDetail={(turn,subtask)=>window.openedSubtask=subtask}
            onOpenTrajectory={()=>{}} onOpenBilling={turn=>window.openedBill=turn}/>
        </main>;
      }createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    const styles = await readFile(resolve('web/src/styles.css'), 'utf8');
    const http = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : request.url === '/styles.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/bundle.js' ? bundle.outputFiles[0]!.text : request.url === '/styles.css' ? styles
        : '<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
    });
    await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser((http.address() as AddressInfo).port, 'conversation-presentation');
      await waitForExpression(browser.cdp, `document.querySelector('.execution-card')?.innerText.includes('正在检索公开资料')`);
      expect(await browser.cdp.evaluate(`document.querySelector('[aria-label="活动任务"]')===null`)).toBe(true);
      expect(await browser.cdp.evaluate(`!document.body.innerText.includes('搜索会话历史')`)).toBe(true);
      await browser.cdp.evaluate(`window.progress()`);
      await waitForExpression(browser.cdp, `document.querySelector('.execution-card')?.innerText.includes('已找到资料，正在整理报告')`);
      await browser.cdp.evaluate(`document.querySelector('.execution-card').click()`);
      expect(await browser.cdp.evaluate('window.openedSubtask')).toBe('subtask');
      const liveShot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile('/tmp/metawork-restored-execution-card.png', Buffer.from(liveShot.data, 'base64'));
      await browser.cdp.evaluate(`window.complete()`);
      await waitForExpression(browser.cdp, `document.querySelector('.final-answer')?.innerText.includes('报告结尾：完整结果自动显示')`);
      await waitForExpression(browser.cdp, `document.querySelector('.turn-bill')?.innerText.includes('0.25 MetaCoin') && document.querySelector('.artifact-link')?.innerText.includes('研究报告.md')`);
      expect(await browser.cdp.evaluate('window.bodyRequests.length')).toBeGreaterThan(1);
      expect(await browser.cdp.evaluate(`document.querySelector('.final-answer h1')?.textContent`)).toBe('研究报告');
      expect(await browser.cdp.evaluate(`!document.body.innerText.includes('阅读完整结果') && !document.body.innerText.includes('下一段')`)).toBe(true);
      await browser.cdp.evaluate(`document.querySelector('.artifact-link').click();document.querySelector('.turn-bill-open').click()`);
      expect(await browser.cdp.evaluate('window.openedArtifact')).toBe('report');
      expect(await browser.cdp.evaluate('window.openedBill')).toBe('turn');
      await browser.cdp.evaluate(`document.querySelector('.workspace-canvas').dispatchEvent(new Event('pointerdown'));document.querySelector('.turn-bill').scrollIntoView({block:'end'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await waitForExpression(browser.cdp, `(()=>{const r=document.querySelector('.turn-bill').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`);
      const finalShot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile('/tmp/metawork-restored-report-bill.png', Buffer.from(finalShot.data, 'base64'));
      await browser.cdp.evaluate(`window.defer=true;window.refresh()`);
      await waitForExpression(browser.cdp, `(window.pending??[]).length>0`);
      await browser.cdp.evaluate(`window.choose('b')`);
      await waitForExpression(browser.cdp, `document.querySelector('.user-message')?.innerText.includes('其他会话')`);
      await browser.cdp.evaluate(`window.release()`);
      await waitForExpression(browser.cdp, `document.querySelector('.turn-bill')?.innerText.includes('0.01 MetaCoin')`);
      expect(await browser.cdp.evaluate(`document.querySelector('.artifact-link')===null && !document.body.innerText.includes('报告结尾')`)).toBe(true);
      // An offscreen long body response may not populate a newly selected Conversation.
      await browser.cdp.evaluate(`window.deferBody=true;window.invalidateBody();window.choose('a')`);
      await waitForExpression(browser.cdp, `(window.pending??[]).length>0`);
      await browser.cdp.evaluate(`window.choose('b')`);
      await waitForExpression(browser.cdp, `document.querySelector('.user-message')?.innerText.includes('其他会话')`);
      await browser.cdp.evaluate(`window.release()`);
      expect(await browser.cdp.evaluate(`!document.body.innerText.includes('报告结尾')`)).toBe(true);
    } finally { await browser?.close(); await new Promise<void>(done => http.close(() => done())); }
  }, 30_000);
});
