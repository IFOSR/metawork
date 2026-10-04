import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const browser = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;

browser('inline DAG in Chrome (real component, isolated fixture)', () => {
  it('renders branches, selects details, resets generations, and scrolls on mobile in both themes', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'metawork-dag-chrome-'));
    const bundle = await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: resolve('web'),
        loader: 'tsx',
      },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    });
    const css = await readFile('web/src/styles.css', 'utf8');
    let report: (value: string) => void = () => undefined;
    const result = new Promise<string>(done => { report = done; });
    const server = createServer((request, response) => {
      if (request.url === '/result') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => { report(body); response.writeHead(200).end(); });
      } else if (request.url === '/app.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].text);
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><main id="root" style="max-width:1050px;margin:24px auto;padding:12px"></main><pre id="result"></pre><script src="/app.js"></script></body></html>`,
        );
      }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1440,1000', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `http://127.0.0.1:${address.port}/`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr?.on('data', chunk => { stderr += String(chunk); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Chrome timed out: ${stderr}`)), 30_000);
          chrome.once('error', reject);
        }),
      ]);
      expect(output).toBe('PASS: 18 browser assertions');
    } finally {
      clearTimeout(timer);
      const exited = new Promise<void>(done => {
        if (chrome.exitCode !== null) done();
        else chrome.once('exit', () => done());
      });
      chrome.kill();
      await exited;
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(profile, { recursive: true, force: true });
    }
  }, 45_000);
});

const fixtureSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorkGraphPanel } from './src/components/WorkGraphPanel';
const root = createRoot(document.getElementById('root'));
const node = (id, title, phase, dependencies) => ({
  id, title, phase, dependencies, goal: title + '的完整目标', status: 'pending', runnable: false,
  requiredCapabilities: [], acceptanceCriteria: [], routing: [],
});
const projection = {
  generationId: 'g1', nodes: [
    node('a', '收集原始材料', 0, []),
    node('b', '核对来源', 1, ['a']),
    node('c', '分析反馈与非常长的子任务标题'.repeat(8), 1, ['a']),
    node('d', '汇总两路证据', 2, ['b', 'c']),
  ],
  edges: [{ from: 'b', to: 'd', kind: 'artifact', label: '核验报告' }],
  parallelGroups: [['a'], ['b','c'], ['d']], currentRunnableFrontier: [],
};
const render = value => flushSync(() => root.render(<WorkGraphPanel projection={value} />));
const check = (value, message) => { if (!value) throw new Error(message); checks++; };
let checks = 0;
try {
  render(projection);
  check(document.querySelectorAll('.work-graph-diagram-node').length === 4, 'four nodes');
  check(document.querySelectorAll('.work-graph-connector').length === 4, 'four arrows');
  check([...document.querySelectorAll('.work-graph-connector')].every(path => path.getAttribute('marker-end').startsWith('url(#dag-arrow-')), 'arrowheads');
  const buttons = document.querySelectorAll('.work-graph-diagram-node');
  check(buttons[1].offsetLeft === buttons[2].offsetLeft && buttons[1].offsetTop !== buttons[2].offsetTop, 'parallel branches');
  flushSync(() => buttons[3].click());
  check(document.querySelector('.work-graph-selected-detail').textContent.includes('汇总两路证据的完整目标'), 'selected goal');
  check(document.querySelector('.work-graph-relations').textContent.includes('核对来源'), 'upstream');
  check(document.querySelector('.work-graph-edges').textContent.includes('核验报告'), 'handoff');
  buttons[2].focus();
  check(document.activeElement === buttons[2], 'keyboard focus');
  for (const theme of ['light', 'dark']) {
    document.documentElement.dataset.theme = theme;
    const style = getComputedStyle(buttons[0]);
    check(style.color !== style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)', theme + ' node surface');
  }
  document.getElementById('root').style.width = '340px';
  const scroll = document.querySelector('.work-graph-canvas-scroll');
  check(scroll.scrollWidth > scroll.clientWidth, 'mobile internal scrolling');
  check(document.querySelector('.work-graph-panel').scrollWidth <= document.querySelector('.work-graph-panel').clientWidth, 'card contains graph');
  scroll.scrollLeft = 1000;
  check(scroll.scrollLeft > 0, 'scroll works');
  flushSync(() => buttons[2].click());
  check(document.querySelector('.work-graph-selected-detail').textContent.includes(projection.nodes[2].title), 'full long title');
  render({ ...projection, generationId: 'g2' });
  check(document.querySelector('.work-graph-diagram-node').getAttribute('aria-pressed') === 'true', 'generation reset');
  render({ ...projection, nodes: [projection.nodes[0]], edges: [] });
  check(document.querySelector('.work-graph-diagram-guide').textContent.includes('1 个子任务'), 'single node');
  check(document.querySelectorAll('.work-graph-connector').length === 0, 'single no arrows');
  render({ ...projection, nodes: [] });
  check(!document.querySelector('svg') && document.body.textContent.includes('暂无可展示'), 'empty');
  document.getElementById('result').textContent = 'PASS: ' + checks + ' browser assertions';
} catch (error) {
  document.getElementById('result').textContent = 'FAIL: ' + error.message;
}
fetch('/result', { method: 'POST', body: document.getElementById('result').textContent });
`;
