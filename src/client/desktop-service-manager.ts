import { spawn } from 'node:child_process';
import { access, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep, resolve } from 'node:path';
import { isInstanceRunning } from '../management/lock.js';
import { readReleaseIdentity } from '../installation/release-identity.js';
import { discoverDesktopSession } from './desktop-session-client.js';
import type { DesktopSessionGrant } from '../gateway/desktop-session-contract.js';
import { resolveClientEndpoint } from './client-endpoint-resolver.js';
import { startMacOSBackgroundProcess } from '../installation/macos-background-process.js';

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
      return;
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

  /** Updater rollback may restore a Web Server predating Desktop sessions. */
  async startForUpdate(): Promise<void> {
    await this.startProcess();
    const deadline = Date.now() + 30_000;
    do {
      const endpoint = await resolveClientEndpoint(join(this.runtime.installRoot, 'server-endpoint.json'), 2,
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
    await discoverDesktopSession({
      installRoot: this.runtime.installRoot,
      manifestPath: join(this.runtime.installRoot, 'server-endpoint.json'),
      releaseId: this.runtime.releaseId,
    });
    await this.stopForUpdate();
  }

  /** Explicit installer action; legacy Web Servers cannot issue Desktop tickets. */
  async stopForUpdate(): Promise<void> {
    const root = await this.releaseRoot();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.runtime.nodePath, [join(root, 'dist', 'index.js'), 'server', 'stop'], {
        cwd: this.runtime.installRoot, env: this.environment(root), stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('后台服务未完成停止，请检查服务状态。')));
    });
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
    return {
      ...env,
      PATH: [dirname(this.runtime.nodePath), join(tools, 'git', 'bin'),
        join(tools, 'executor', 'bin'), join(root, 'bin'), env.PATH ?? '/usr/bin:/bin'].join(':'),
      METAWORK_INSTALL_ROOT: this.runtime.installRoot,
      ANYFUSION_INSTALL_ROOT: this.runtime.installRoot,
      ...(this.runtime.configHome ? { METAWORK_CONFIG_HOME: this.runtime.configHome, ANYFUSION_CONFIG_HOME: this.runtime.configHome } : {}),
      METAWORK_RELEASE_ID: this.runtime.releaseId,
      METACLAW_EXECUTOR_BACKEND: 'worktree',
      ANYFUSION_PI_SOURCE_ROOT: join(root, 'planner'),
      METACLAW_PLANNER_COMMAND: join(root, 'planner', 'packages', 'coding-agent', 'dist', 'cli.js'),
      METACLAW_PLANNER_SCHEMA_PATH: join(root, 'dist', 'planning-agent-plan-v8.schema.json'),
      ANYFUSION_PLANNER_SCHEMA_PATH: join(root, 'dist', 'planning-agent-plan-v8.schema.json'),
      METACLAW_PI_ATTEMPT_EXTENSION: join(root, 'dist', 'pi-attempt-tools.ts'),
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
  }
}
