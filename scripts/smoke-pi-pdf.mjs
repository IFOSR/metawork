import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// Build first, then run bundled Python on scripts/generate-pi-pdf-fixtures.py.
const root = resolve(process.argv[2] || '.tmp/pdf-acceptance');
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required; it is never written to the Pi home.');
const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'));
const metrics = { requests: 0, imageRequests: 0, toolNames: new Set(), usage: [] };
const proxy = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    metrics.requests++;
    if (body.messages?.some(message => Array.isArray(message.content)
      && message.content.some(content => content.type === 'image_url'))) metrics.imageRequests++;
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: raw,
    });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end(JSON.stringify({ error: 'Test proxy upstream failure' }));
  }
});
await new Promise((resolveReady, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', resolveReady);
});
try {
  const home = join(root, 'pi-home');
  const agent = join(home, '.pi/agent');
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { acceptance: {
    baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`, api: 'openai-completions', apiKey: '$PDF_TEST_KEY',
    models: [{ id: 'deepseek-flash', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
  } } }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'acceptance', defaultModel: 'deepseek-flash' }));
  const prompt = 'Read text.pdf and scan.pdf (synthetic invoices). Use pdf_info and pdf_extract_text; '
    + 'for the scanned PDF use pdf_to_images with output_dir="pages", then read the PNG with read. '
    + 'Do not use bash, qlmanage, sips or install anything. Return invoice number, date, amount, currency '
    + 'and source page for each, then sum CNY amounts accurately. Do not guess missing fields.';
  const child = spawn(process.env.METAWORK_PI_COMMAND || 'pi', [
    '--mode', 'json', '--no-session', '--provider', 'acceptance', '--model', 'deepseek-flash',
    '--extension', resolve('dist/pi-pdf/index.ts'),
    '--tools', 'read,pdf_info,pdf_extract_text,pdf_extract_tables,pdf_to_images', prompt,
  ], { cwd: root, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PDF_TEST_KEY: 'local-test',
    PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject); child.once('close', resolveExit);
  });
  await writeFile(join(root, 'pi-live.jsonl'), output);
  await writeFile(join(root, 'pi-live.stderr'), stderr);
  assert.equal(code, 0, stderr.slice(-1500));
  let final = '';
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'tool_execution_start') metrics.toolNames.add(event.toolName);
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      final = (event.message.content || []).filter(content => content.type === 'text').map(content => content.text).join('');
      if (event.message.usage) metrics.usage.push(event.message.usage);
    }
  }
  assert.ok(metrics.imageRequests > 0, 'Real image request must reach DeepSeek');
  for (const name of ['pdf_extract_text', 'pdf_to_images', 'read']) assert.ok(metrics.toolNames.has(name), `Missing tool: ${name}`);
  for (const value of expected.requiredText) assert.ok(final.includes(value), `Missing expected invoice field: ${value}`);
  await writeFile(join(root, 'pi-live-evidence.json'), JSON.stringify({
    ...metrics, toolNames: [...metrics.toolNames], passed: true, final,
  }, null, 2));
  process.stdout.write(`Pi PDF vision smoke passed: ${metrics.imageRequests} image request(s), exact invoice values verified.\n`);
} finally {
  proxy.closeAllConnections(); proxy.close();
}
