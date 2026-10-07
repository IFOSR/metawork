import { spawn } from 'node:child_process';
import { access, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { isInstanceRunning } from '../management/lock.js';
import { readReleaseIdentity } from '../installation/release-identity.js';
import { desktopProcessEnvironment } from '../installation/desktop-platform.js';
import { discoverDesktopSession } from './desktop-session-client.js';
import type { DesktopSessionGrant } from '../gateway/desktop-session-contract.js';

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
    const root = await this.releaseRoot();
    const lock = join(this.runtime.installRoot, 'data', 'runtime.lock');
    if (await isInstanceRunning(lock)) {
      // A live incompatible instance must never trigger another Server spawn.
      return this.waitReady();
    }
    await mkdir(join(this.runtime.installRoot, 'logs'), { recursive: true, mode: 0o700 });
    const log = await open(join(this.runtime.installRoot, 'logs', 'desktop-server.log'), 'a', 0o600);
    try {
      const child = spawn(this.runtime.nodePath, [join(root, 'dist', 'index.js'), 'server', 'start'], {
        cwd: this.runtime.installRoot, env: this.environment(root), detached: true,
        stdio: ['ignore', log.fd, log.fd], windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } finally { await log.close(); }
    return this.waitReady();
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
    const root = await this.releaseRoot();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.runtime.nodePath, [join(root, 'dist', 'index.js'), 'server', 'stop'], {
        cwd: this.runtime.installRoot, env: this.environment(root), stdio: 'ignore', windowsHide: true,
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
    const env = desktopProcessEnvironment({ releaseRoot: root, nodePath: this.runtime.nodePath,
      env: this.runtime.env ?? process.env, inheritPath: true, includeReleaseBin: true });
    delete env.ANYFUSION_PLANNER_WORKSPACE;
    delete env.METACLAW_PLANNER_WORKDIR;
    return {
      ...env,
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
