/**
 * Shared harness for the memory end-to-end suites.
 *
 * Starts a real TDAI MemoryCore sidecar on a temporary data directory and shuts
 * it down deterministically: the process must actually exit before its data
 * directory is removed, otherwise SQLite's WAL files race the cleanup.
 *
 * Test support module: never imported by production code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MemoryEngineHandle {
  port: number;
  dataDir: string;
  kernelAuthToken: string;
  stop(): Promise<void>;
}

export function resolveMemoryEngineRoot(): string | null {
  const explicit = process.env.METAWORK_MEMORY_SIDECAR_DIR?.trim();
  const candidates = [explicit, resolve(process.cwd(), '.tmp/tdai/MemoryCore')]
    .filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'src/gateway/server.ts'))) return candidate;
  }
  return null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json() as { stores?: { ftsAvailable?: boolean } };
        if (body?.stores?.ftsAvailable === true) return true;
      }
    } catch { /* the engine is still starting */ }
    await new Promise(done => setTimeout(done, 500));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(done => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done();
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
}

export async function startMemoryEngine(input: {
  engineRoot: string;
  llmBaseUrl: string;
  /** Fixed port keeps the config deterministic; a free port is found otherwise. */
  port?: number;
}): Promise<MemoryEngineHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'metawork-memory-e2e-'));
  const port = input.port ?? 18_700 + Math.floor(Math.random() * 400);
  const kernelAuthToken = `e2e-kernel-${Math.random().toString(36).slice(2)}`;
  const configPath = join(dataDir, 'tdai-gateway.standalone.yaml');
  writeFileSync(configPath, [
    'deployMode: standalone', 'stateBackend: "local"',
    'server:', `  port: ${port}`, '  host: "127.0.0.1"',
    '  apiKey: "${TDAI_KERNEL_AUTH_TOKEN}"',
    'data:', `  baseDir: "${dataDir}/data"`,
    'llm:', `  baseUrl: "${input.llmBaseUrl}"`, '  apiKey: "${TDAI_LLM_API_KEY}"',
    '  model: "mock-extraction-model"', '  maxTokens: 2048', '  timeoutMs: 60000',
    'memory:',
    '  capture: { enabled: true }',
    '  extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 }',
    '  persona: { triggerEveryN: 50, maxScenes: 15, triggerMode: current }',
    '  pipeline:',
    '    everyNConversations: 1', '    enableWarmup: false', '    l1IdleTimeoutSeconds: 1',
    '    l2DelayAfterL1Seconds: 90', '    l2MinIntervalSeconds: 900', '    l2MaxIntervalSeconds: 3600',
    '  recall: { enabled: true, maxResults: 5, scoreThreshold: 0.3, strategy: "hybrid", timeoutMs: 5000 }',
    '  storeBackend: "sqlite"', '  embedding: { provider: "none" }',
    '  bm25: { enabled: true, language: "zh" }', '',
  ].join('\n'));

  const child = spawn(process.execPath, ['--import', 'tsx', join(input.engineRoot, 'src/gateway/server.ts')], {
    cwd: input.engineRoot,
    env: {
      ...process.env,
      TDAI_GATEWAY_CONFIG: configPath,
      TDAI_GATEWAY_PORT: String(port),
      TDAI_GATEWAY_HOST: '127.0.0.1',
      TDAI_DATA_DIR: join(dataDir, 'data'),
      TDAI_LLM_API_KEY: 'mock-llm-key',
      TDAI_KERNEL_AUTH_TOKEN: kernelAuthToken,
      TDAI_METADATA_SQLITE_BASE_DIR: join(dataDir, 'metadata'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);

  const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, 90_000);
  if (!healthy) {
    await waitForExit(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error('memory engine did not become healthy');
  }
  return {
    port,
    dataDir,
    kernelAuthToken,
    async stop() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await waitForExit(child);
      // The engine closes its SQLite store during shutdown; removing the
      // directory afterwards keeps WAL/checkpoint files from racing us.
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
