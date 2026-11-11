/**
 * Memory sidecar lifecycle.
 *
 * The memory engine runs as a local sidecar process. This module owns exactly
 * three things:
 *   - starting it when memory is enabled and auto-start is on;
 *   - probing it, including the BM25/FTS5 gate (design R2: without FTS5 the
 *     recall silently returns empty, so it is a blocking check);
 *   - stopping it with the server.
 *
 * Credentials live only in the sidecar's environment, and that environment is
 * an explicit allowlist rather than a copy of the Server environment
 * (design §6.4). The Server's own `process.env` is never polluted, because the
 * Planner process tree inherits it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { MemoryEngineHealth } from './memory-types.js';
import { isTcpEndpointListening, memorySidecarSupervisor } from './memory-sidecar-supervisor.js';

/**
 * Environment variables the sidecar inherits from the Server process.
 *
 * Everything else (Feishu secrets, official-service credentials, billing keys,
 * Provider keys for other models) must not reach the engine. The engine only
 * needs to locate Node, resolve its own modules, write temporary files and
 * reach its extraction Provider.
 */
const INHERITED_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_ENV',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** Build the minimal sidecar environment: inherited allowlist plus explicit values. */
export function buildSidecarEnvironment(
  explicit: Readonly<Record<string, string>>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...explicit };
}

export interface MemorySidecarOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  /** Health probe URL of the running engine. */
  healthUrl: string;
  timeoutMs?: number;
  /**
   * The engine may expose HTTP before its store and indexes are ready, so a
   * probe only counts once the store reports usable. `status` values other than
   * `ok` are treated as not-ready.
   */
  readyTimeoutMs?: number;
  /** Bounded automatic restarts after a crash (design §11). */
  maxRestarts?: number;
  /**
   * Engine endpoint. When something already listens there the sidecar refuses to
   * attach: that process was not started by MetaWork and carries older
   * configuration, so it must be stopped instead of silently adopted.
   */
  preflight?: { host: string; port: number };
  logger?: (message: string) => void;
  /** Injected for tests; defaults to `process.env` for the inherited keys. */
  environment?: NodeJS.ProcessEnv;
}

export interface MemorySidecarStatus {
  running: boolean;
  healthy: boolean;
  ftsAvailable: boolean;
  restarts: number;
  detail?: string;
}

/**
 * One health verdict used by every layer (review P2-5).
 *
 * The engine is usable only when its store reports FTS5 and its own status is
 * absent or an explicit healthy value. An unknown/error status keeps the seam
 * closed even when FTS5 happens to be present.
 */
export function interpretEngineHealth(body: {
  status?: string;
  version?: string;
  stores?: { ftsAvailable?: boolean };
} | null): MemoryEngineHealth {
  const ftsAvailable = body?.stores?.ftsAvailable === true;
  const status = body?.status;
  const statusHealthy = status === undefined || status === 'ok' || status === 'healthy';
  const ready = ftsAvailable && statusHealthy;
  return {
    ready,
    ftsAvailable,
    ...(body?.version === undefined ? {} : { version: body.version }),
    ...(ready
      ? {}
      : {
        detail: ftsAvailable
          ? `engine_status_${status ?? 'unknown'}`
          : 'fts5_unavailable',
      }),
  };
}

export class MemorySidecar {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private lastHealth: MemoryEngineHealth = { ready: false, ftsAvailable: false };
  private portConflict: string | null = null;
  private stopping = false;
  /** Pending restart, retained so `stop` can cancel it (review P2-6). */
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly logger: (message: string) => void;

  constructor(private readonly options: MemorySidecarOptions) {
    this.logger = options.logger ?? (() => undefined);
  }

  get status(): MemorySidecarStatus {
    return {
      running: this.child !== null,
      healthy: this.lastHealth.ready,
      ftsAvailable: this.lastHealth.ftsAvailable,
      restarts: this.restarts,
      detail: this.lastHealth.detail,
    };
  }

  /** Start the sidecar and wait until it reports a usable health state. */
  async start(): Promise<MemorySidecarStatus> {
    if (this.child) return this.status;
    this.stopping = false;
    this.cancelPendingRestart();
    this.portConflict = null;
    if (this.options.preflight
      && await isTcpEndpointListening(this.options.preflight.host, this.options.preflight.port)) {
      const endpoint = `${this.options.preflight.host}:${this.options.preflight.port}`;
      this.portConflict = endpoint;
      this.lastHealth = {
        ready: false,
        ftsAvailable: false,
        detail: `memory_engine_port_in_use: ${endpoint}`,
      };
      this.logger(
        `memory engine port ${endpoint} is already in use by a process MetaWork does not own; `
        + 'stop it (or change memory.sidecar.port) instead of attaching to stale configuration',
      );
      return this.status;
    }
    // Run the engine under the parent-death supervisor so it can never outlive
    // the Server, including when the shutdown watchdog SIGKILLs the Server.
    const supervisor = memorySidecarSupervisor({
      command: this.options.command,
      args: this.options.args,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    });
    const child = spawn(supervisor.command, supervisor.args, {
      cwd: this.options.cwd,
      env: buildSidecarEnvironment(this.options.env, this.options.environment ?? process.env),
      // The wrapper owns its group: a forced stop takes the engine down with it.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The write end stays open for the Server's whole lifetime and is never
    // written to: EOF is the supervisor's only parent-death signal.
    child.stdin?.on('error', () => undefined);
    // The sidecar is intentionally not allowed to stream unredacted memory or
    // provider diagnostics into the Server log. Drain both pipes so a verbose
    // extraction cannot block on a full OS pipe buffer.
    child.stdout?.resume();
    child.stderr?.resume();
    this.child = child;
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) return;
      this.logger(`memory sidecar exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      if (this.restarts < (this.options.maxRestarts ?? 3)) {
        this.restarts += 1;
        this.logger(`memory sidecar restart #${this.restarts}`);
        this.scheduleRestart();
      }
    });
    const health = await this.waitUntilHealthy();
    return { ...this.status, healthy: health.ready, ftsAvailable: health.ftsAvailable };
  }

  /** Bounded serial restart that `stop` can always cancel. */
  private scheduleRestart(): void {
    this.cancelPendingRestart();
    const timer = setTimeout(() => {
      this.restartTimer = null;
      // `stop` may have been called while the timer was pending.
      if (this.stopping) return;
      void this.start();
    }, 1_000);
    timer.unref?.();
    this.restartTimer = timer;
  }

  private cancelPendingRestart(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Probe the engine health, including the FTS5 gate. */
  async probe(): Promise<MemoryEngineHealth> {
    // Never talk to an engine we did not start: it would report the health and
    // configuration of a previous Server instance.
    if (this.portConflict) return this.lastHealth;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await fetch(this.options.healthUrl, { signal: controller.signal });
      if (!response.ok) {
        this.lastHealth = { ready: false, ftsAvailable: false, detail: `health_http_${response.status}` };
        return this.lastHealth;
      }
      const body = await response.json() as {
        status?: string;
        version?: string;
        stores?: { ftsAvailable?: boolean };
      };
      this.lastHealth = interpretEngineHealth(body);
      return this.lastHealth;
    } catch (error) {
      this.lastHealth = {
        ready: false,
        ftsAvailable: false,
        detail: `health_unreachable: ${(error as Error).message}`,
      };
      return this.lastHealth;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wait for the engine to report a usable health state.
   *
   * The engine needs a moment to open its store and build its indexes, so a
   * single probe right after the spawn is not enough. The wait is bounded: a
   * sidecar that never becomes healthy leaves the memory seam closed rather
   * than blocking the Server startup.
   */
  private async waitUntilHealthy(): Promise<MemoryEngineHealth> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    let health = await this.probe();
    while (!health.ready && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      health = await this.probe();
    }
    return health;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Cancel first: a restart scheduled one second ago must not resurrect the
    // engine after the Server has stopped (review P2-6).
    this.cancelPendingRestart();
    const child = this.child;
    this.child = null;
    if (!child) return;
    const pid = child.pid;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && pid) process.kill(-pid, name);
        else child.kill(name);
      } catch { /* already gone */ }
    };
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 3_000);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      signal('SIGTERM');
    });
  }
}
