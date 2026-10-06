import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';
import { prepareDevelopmentShell } from '../packaging/development-shell.mjs';

const execute = promisify(execFile);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.METAWORK_DESKTOP_DEVELOPMENT_ROOT ?? join(desktop, '../../.tmp/desktop-development'));
// Cold samples stop only this explicitly marked development installation.
const marker = JSON.parse(await readFile(join(root, 'desktop-development.json'), 'utf8'));
assert.equal(marker.purpose, 'isolated-desktop-development');
const releaseId = JSON.parse(await readFile(join(root, 'app/current/release-identity.json'), 'utf8')).releaseId;
const samples = Number(process.env.METAWORK_DESKTOP_BENCHMARK_SAMPLES ?? 20);
assert.ok(Number.isSafeInteger(samples) && samples >= 5 && samples <= 100);
const env = { ...process.env, METAWORK_DESKTOP_DEVELOPMENT_ROOT: root,
  METAWORK_DESKTOP_NODE: process.execPath, METAWORK_DESKTOP_RELEASE: releaseId,
  METAWORK_INSTALL_ROOT: root, ANYFUSION_INSTALL_ROOT: root, METAWORK_WEB_PORT: '0',
  METAWORK_CONFIG_HOME: join(root, 'config-home'), ANYFUSION_CONFIG_HOME: join(root, 'config-home'),
  METACLAW_DISABLE_MARKDOWN_PREVIEW: '1' };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'METAWORK_DESKTOP_UI_ORIGIN']) delete env[key];
const executablePath = await prepareDevelopmentShell();

async function measure() {
  const started = performance.now();
  const app = await _electron.launch({ executablePath, args: [desktop], env, timeout: 30000 });
  try {
    const page = await app.firstWindow();
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const deadline = Date.now() + 10000;
      while (!window.isVisible()) {
        if (Date.now() > deadline) throw new Error('Startup window not visible');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    const visibleMs = Math.round(performance.now() - started);
    await page.locator('.workspace-shell').waitFor({ timeout: 45000 });
    const readyMs = Math.round(performance.now() - started);
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).authenticated), true);
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
      type: metric.type, cpuPercent: metric.cpu.percentCPUUsage, workingSetKiB: metric.memory.workingSetSize,
    })));
    const manifest = JSON.parse(await readFile(join(root, 'server-endpoint.json'), 'utf8'));
    const stats = (await execute('/bin/ps', ['-p', String(manifest.pid), '-o', 'rss=', '-o', '%cpu='])).stdout.trim().split(/\s+/u).map(Number);
    return { visibleMs, readyMs, desktopProcesses: metrics, server: { rssKiB: stats[0], cpuPercent: stats[1] } };
  } finally { await app.close(); }
}

const result = { generatedAt: new Date().toISOString(), arch: process.arch, samplesPerMode: samples,
  scope: 'Development Electron; installed production Web; system-managed deepseek-flash connection; no model tasks or signed payload verification; cold means stopped Server, not OS reboot or cleared file caches',
  warm: [], cold: [] };
await measure(); // Ensure Server exists for warm samples; exclude warm-up.
for (const mode of ['warm', 'cold']) {
  for (let index = 0; index < samples; index++) {
    if (mode === 'cold') await execute(process.execPath, [join(root, 'app/current/dist/index.js'), 'server', 'stop'], { env, timeout: 45000 });
    result[mode].push(await measure());
    if ((index + 1) % 5 === 0) process.stdout.write(`${mode}: ${index + 1}/${samples} samples\n`);
  }
}
const percentile = (rows, field, fraction) => [...rows].map(row => row[field]).sort((a, b) => a - b)[Math.ceil(rows.length * fraction) - 1];
result.summary = Object.fromEntries(['warm', 'cold'].map(mode => [mode, {
  readyMedianMs: percentile(result[mode], 'readyMs', 0.5), readyP95Ms: percentile(result[mode], 'readyMs', 0.95),
  visibleP95Ms: percentile(result[mode], 'visibleMs', 0.95),
}]));
await mkdir(join(root, 'evidence'), { recursive: true });
await writeFile(join(root, 'evidence/startup-benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result.summary)}\nServer remains running in the isolated development installation.\n`);
