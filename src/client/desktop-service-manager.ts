import { spawn } from 'node:child_process';
import { access, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, relative, isAbsolute, sep, resolve } from 'node:path';
import { isInstanceRunning } from '../management/lock.js';
import { readReleaseIdentity } from '../installation/release-identity.js';
import { discoverDesktopSession } from './desktop-session-client.js';
import type { DesktopSessionGrant } from '../gateway/desktop-session-contract.js';
import { GATEWAY_PROTOCOL_VERSION } from '../gateway/client-protocol.js';
import { resolveClientEndpoint } from './client-endpoint-resolver.js';
import { startMacOSBackgroundProcess } from '../installation/macos-background-process.js';
import { captureMacOSServerProcess, finishMacOSServerExit } from '../installation/macos-server-exit.js';

export interface DesktopRuntime {
  installRoot: string;
  configHome?: string;
  nodePath: string;
  releaseId: string;
  env?: NodeJS.ProcessEnv;
}

/** Lifecycle adapter only. No Server composition, storage or recovery policy. */
export class DesktopServiceManager {
  private connecting: Promise<DesktopSessionGrant> | null = null;
  constructor(private readonly runtime: DesktopRuntime) {}

  connect(): Promise<DesktopSessionGrant> {
    this.connecting ??= this.connectOnce().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectOnce(): Promise<DesktopSessionGrant> {
    await this.startProcess();
    return this.waitReady();
  }

  private async startProcess(): Promise<void> {
    const root = await this.releaseRoot();
    const lock = join(this.runtime.installRoot, 'data', 'runtime.lock');
    if (await isInstanceRunning(lock)) {
      // A live incompatible instance must never trigger another Server spawn.
      // It may, however, be an instance that already withdrew its endpoints and
      // never finished exiting. Reclaiming it is the only way `reconnect` can
      // recover, so verify readiness before deciding to reuse it.
      if (await this.publishedEndpointReady()) return;
      if (process.platform === 'darwin') {
        const stuck = await captureMacOSServerProcess(this.runtime.installRoot);
        if (stuck) await finishMacOSServerExit(stuck);
      } else return;
    } else if (process.platform === 'darwin') {
      // The lock is gone but launchd may still own the PID of the same stuck
      // instance; startMacOSBackgroundProcess would treat that as reusable.
      const stuck = await captureMacOSServerProcess(this.runtime.installRoot);
      if (stuck && !await this.publishedEndpointReady()) await finishMacOSServerExit(stuck);
    }
    await mkdir(join(this.runtime.installRoot, 'logs'), { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      await startMacOSBackgroundProcess({ root: this.runtime.installRoot, role: 'server',
        executable: this.runtime.nodePath, args: [join(root, 'dist', 'index.js'), 'server', 'start'],
        cwd: this.runtime.installRoot, env: this.environment(root),
        logPath: join(this.runtime.installRoot, 'logs', 'desktop-server.log') });
      return;
    }
    const log = await open(join(this.runtime.installRoot, 'logs', 'desktop-server.log'), 'a', 0o600);
    try {
      const child = spawn(this.runtime.nodePath, [join(root, 'dist', 'index.js'), 'server', 'start'], {
        cwd: this.runtime.installRoot, env: this.environment(root), detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally { await log.close(); }
  }

  private async publishedEndpointReady(): Promise<boolean> {
    const endpoint = await resolveClientEndpoint(join(this.runtime.installRoot, 'server-endpoint.json'), GATEWAY_PROTOCOL_VERSION,
      { releaseId: this.runtime.releaseId });
    return endpoint.ok;
  }

  /** Updater rollback may restore a Web Server predating Desktop sessions. */
  async startForUpdate(): Promise<void> {
    await this.startProcess();
    const deadline = Date.now() + 30_000;
    do {
      const endpoint = await resolveClientEndpoint(join(this.runtime.installRoot, 'server-endpoint.json'), GATEWAY_PROTOCOL_VERSION,
        { releaseId: this.runtime.releaseId });
      if (endpoint.ok) return;
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    throw new Error('Previous Server did not become ready');
  }

  private async waitReady(): Promise<DesktopSessionGrant> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    do {
      try {
        return await discoverDesktopSession({
          installRoot: this.runtime.installRoot,
          manifestPath: join(this.runtime.installRoot, 'server-endpoint.json'),
          releaseId: this.runtime.releaseId,
        });
      } catch (error) {
        lastError = error;
        if (/mismatch|permissions|ownership|Invalid/u.test((error as Error).message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    throw new Error('后台服务未能就绪，请检查安装与服务日志。', { cause: lastError });
  }

  async stop(): Promise<void> {
    // Verify the running owner and instance before invoking the formal global stop.
    // A Server stuck in exit has no endpoint to verify, which must not block the
    // only path that can reclaim it.
    try {
      await discoverDesktopSession({
        installRoot: this.runtime.installRoot,
        manifestPath: join(this.runtime.installRoot, 'server-endpoint.json'),
        releaseId: this.runtime.releaseId,
      });
    } catch (error) {
      if (await this.publishedEndpointReady()) throw error;
    }
    await this.stopForUpdate();
  }

  /**
   * Explicit installer action; legacy Web Servers cannot issue Desktop tickets.
   *
   * `drainTimeoutMs` bounds how long the installation may still report a live
   * instance before the stuck-exit path takes over.
   */
  async stopForUpdate(options: { drainTimeoutMs?: number; pollMs?: number } = {}): Promise<void> {
    const drainTimeoutMs = options.drainTimeoutMs ?? 45_000;
    const pollMs = options.pollMs ?? 300;
    const root = await this.releaseRoot();
    const lock = join(this.runtime.installRoot, 'data', 'runtime.lock');
    const background = process.platform === 'darwin' ? await captureMacOSServerProcess(this.runtime.installRoot) : null;
    const stopped = await new Promise<void>((resolve, reject) => {
      const child = spawn(this.runtime.nodePath, [join(root, 'dist', 'index.js'), 'server', 'stop'], {
        cwd: this.runtime.installRoot, env: this.environment(root), stdio: 'ignore',
      });
      // Bound the stop CLI too: it is a separate Node process and may itself
      // stall in native exit. Killing this command does not kill Server.
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Server stop command timed out')); }, 60_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('后台服务未完成停止，请检查服务状态。')); });
    }).then(() => ({ error: null as unknown }), error => ({ error }));
    // The stop CLI grants the Server a fixed grace window that a drain with an
    // unreachable memory engine routinely exceeds. Its exit code therefore says
    // nothing about the installation: a stop succeeds only when this
    // installation has no live instance left.
    if (background) await finishMacOSServerExit(background);
    if (await this.waitForInstanceExit(lock, drainTimeoutMs, pollMs)) return;
    // Still alive after the drain window: reclaim it as a stuck exit. Reaching
    // here with published endpoints means the Server hung inside its own
    // shutdown, which the update cannot proceed without.
    const stuck = process.platform === 'darwin'
      ? await captureMacOSServerProcess(this.runtime.installRoot).catch(() => null)
      : null;
    if (stuck) await finishMacOSServerExit(stuck, { forceUnwithdrawn: true });
    if (await this.waitForInstanceExit(lock, Math.min(10_000, drainTimeoutMs), pollMs)) return;
    throw stopped.error ?? new Error('Another Server is running after stop');
  }

  private async waitForInstanceExit(lock: string, timeoutMs: number, pollMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (await isInstanceRunning(lock)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return true;
  }

  private async releaseRoot(): Promise<string> {
    if (!isAbsolute(this.runtime.nodePath)) throw new Error('Node executable must be absolute');
    await access(this.runtime.nodePath, constants.X_OK);
    const root = await realpath(join(this.runtime.installRoot, 'app', 'current'));
    const releases = await realpath(join(this.runtime.installRoot, 'app', 'releases'));
    const child = relative(releases, root);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('Server must run from an installed immutable release');
    }
    const identity = await readReleaseIdentity(join(root, 'release-identity.json'));
    if (identity?.releaseId !== this.runtime.releaseId) throw new Error('Installed release mismatch');
    await access(join(root, 'dist', 'index.js'));
    return root;
  }

  private environment(root: string): NodeJS.ProcessEnv {
    const env = { ...(this.runtime.env ?? process.env) };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ANYFUSION_PLANNER_WORKSPACE;
    delete env.METACLAW_PLANNER_WORKDIR;
    const tools = resolve(dirname(this.runtime.nodePath), '../..');
    // Windows PATH entries are `;`-joined; a `:` join yields one mangled entry.
    const pathEntries = [
      dirname(this.runtime.nodePath),
      join(tools, 'git', 'bin'),
      join(tools, 'executor', 'bin'),
      join(root, 'bin'),
      env.PATH ?? '',
    ].filter(entry => entry !== '');
    return {
      ...env,
      PATH: pathEntries.join(delimiter),
      METAWORK_INSTALL_ROOT: this.runtime.installRoot,
      ANYFUSION_INSTALL_ROOT: this.runtime.installRoot,
      ...(this.runtime.configHome ? { METAWORK_CONFIG_HOME: this.runtime.configHome, ANYFUSION_CONFIG_HOME: this.runtime.configHome } : {}),
      METAWORK_RELEASE_ID: this.runtime.releaseId,
      METAWORK_MANAGED_PI: join(tools, 'executor', 'bin', 'pi'),
      // The retired `in_place` executor mode was renamed to `native`; the shell
      // must launch the Runtime with the supported value.
      METACLAW_EXECUTOR_BACKEND: 'native',
      ANYFUSION_PI_SOURCE_ROOT: join(root, 'planner'),
      METACLAW_PLANNER_COMMAND: join(root, 'planner', 'packages', 'coding-agent', 'dist', 'cli.js'),
      METACLAW_PLANNER_SCHEMA_PATH: join(root, 'dist', 'planning-agent-plan-v9.schema.json'),
      ANYFUSION_PLANNER_SCHEMA_PATH: join(root, 'dist', 'planning-agent-plan-v9.schema.json'),
      METACLAW_PI_ATTEMPT_EXTENSION: join(root, 'dist', 'pi-attempt-tools.ts'),
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
  }
}
