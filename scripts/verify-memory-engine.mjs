#!/usr/bin/env node
// Starts the memory engine exactly as the release will start it and fails the
// build unless the engine is reachable AND its SQLite reports FTS5.
//
// BM25 recall silently returns nothing without FTS5, so the gate is blocking
// (ADR-0049). Without this check a release could ship a "long-term memory"
// switch that can never recall anything.
//
// Usage:
//   node scripts/verify-memory-engine.mjs [--memory-root <dir>] [--timeout-ms <n>]
//
// Defaults to $METAWORK_MEMORY_ENGINE_ROOT or <repo>/memory/tdai.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const memoryRoot = resolve(
  argument('--memory-root', process.env.METAWORK_MEMORY_ENGINE_ROOT ?? join(repoRoot, 'memory', 'tdai')),
);
const timeoutMs = Number(argument('--timeout-ms', '90000'));
const entry = join(memoryRoot, 'dist', 'gateway', 'server.js');
const port = Number(argument('--port', String(8500 + Math.floor(Math.random() * 400))));

const root = mkdtempSync(join(tmpdir(), 'metawork-memory-verify-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const configPath = join(root, 'gateway.yaml');
const token = `verify-${Math.random().toString(36).slice(2)}`;

writeFileSync(configPath, [
  'deployMode: standalone',
  'stateBackend: "local"',
  'server:',
  `  port: ${port}`,
  '  host: "127.0.0.1"',
  '  apiKey: "${TDAI_KERNEL_AUTH_TOKEN}"',
  'data:',
  `  baseDir: "${dataDir}"`,
  'llm:',
  '  baseUrl: "http://127.0.0.1:1/v1"',
  '  apiKey: "${TDAI_LLM_API_KEY}"',
  '  model: "verification-model"',
  'memory:',
  '  capture:',
  '    enabled: true',
  '  extraction:',
  '    enabled: false',
  '  recall:',
  '    enabled: true',
  '    strategy: "hybrid"',
  '  storeBackend: "sqlite"',
  '  embedding:',
  '    provider: "none"',
  '  bm25:',
  '    enabled: true',
  '    language: "zh"',
  '',
].join('\n'));

const child = spawn(process.execPath, [entry], {
  cwd: memoryRoot,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    NODE_ENV: 'production',
    TDAI_GATEWAY_CONFIG: configPath,
    TDAI_GATEWAY_PORT: String(port),
    TDAI_GATEWAY_HOST: '127.0.0.1',
    TDAI_DATA_DIR: dataDir,
    TDAI_LLM_API_KEY: token,
    TDAI_LLM_BASE_URL: 'http://127.0.0.1:1/v1',
    TDAI_LLM_MODEL: 'verification-model',
    TDAI_KERNEL_AUTH_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });

function stop() {
  if (!child.killed) child.kill('SIGTERM');
}

try {
  const deadline = Date.now() + timeoutMs;
  let health;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`memory engine exited with code ${child.exitCode}\n${output.slice(-4000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        health = await response.json();
        if (health?.status === 'ok' || health?.status === 'healthy') break;
      }
    } catch {
      // The engine may still be starting; keep polling until the deadline.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  if (!health) throw new Error(`memory engine did not become healthy within ${timeoutMs}ms\n${output.slice(-4000)}`);
  if (health.stores?.ftsAvailable !== true) {
    throw new Error(
      'memory engine lacks SQLite FTS5; BM25 recall would silently return nothing: '
      + JSON.stringify(health.stores ?? null),
    );
  }
  process.stdout.write(
    `memory engine verified: status=${health.status} ftsAvailable=true`
    + `${health.version ? ` version=${health.version}` : ''}\n`,
  );
} finally {
  stop();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  rmSync(root, { recursive: true, force: true });
}
