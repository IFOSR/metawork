import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDesktopRelease, type DesktopRelease } from '../../../src/installation/desktop-release.js';
import { readReleaseIdentity } from '../../../src/installation/release-identity.js';
import { desktopSupportRoot } from '../../../src/installation/desktop-support.js';
import type { DesktopSetupInput } from '../shared/bridge.js';

/** Installation transport only: database/configuration/activation remain in the native helper. */
export class DesktopInstallation {
  private release: DesktopRelease | null = null;
  private installing = false;
  constructor(readonly resources: string, readonly root: string, private readonly version: string) {}
  async verify(): Promise<DesktopRelease> {
    if (this.release) return this.release;
    const keys = JSON.parse(await readFile(join(this.resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
    const descriptor = JSON.parse(await readFile(join(this.resources, 'desktop-release.json'), 'utf8')) as { development?: boolean };
    this.release = await verifyDesktopRelease(this.resources, { trustedKeys: keys, arch: process.arch,
      desktopVersion: this.version, allowDevelopment: descriptor.development === true });
    return this.release;
  }
  async installed(): Promise<boolean> {
    return access(join(this.root, 'app/current/release-identity.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
  }
  async needsUpgrade(): Promise<boolean> {
    const release = await this.verify();
    const identity = await readReleaseIdentity(join(this.root, 'app/current/release-identity.json'));
    return identity !== null && identity.releaseId !== release.releaseId;
  }
  async nodePath(): Promise<string> {
    // Older native installations may not contain Desktop's bundled Node. Check
    // compatibility first so they report a version mismatch, not a startup error.
    const release = await this.verify();
    const identity = await readReleaseIdentity(join(this.root, 'app/current/release-identity.json'));
    if (identity?.releaseId !== release.releaseId) throw new Error('Installed release mismatch');
    try { return await realpath(join(this.root, 'app/current/desktop-tools/node/bin/node')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Native Web releases omit Desktop tools. Provision a durable helper/tool
    // directory, preserving the immutable release and all existing account data.
    await this.run('prepare-desktop');
    return realpath(join(desktopSupportRoot(this.root, release.releaseId), 'desktop-tools/node/bin/node'));
  }
  async run(command: 'install' | 'update' | 'rollback' | 'prepare-desktop', provider?: DesktopSetupInput): Promise<void> {
    if (this.installing) throw new Error('Installation already in progress');
    this.installing = true;
    try {
      this.release = null;
      const release = await this.verify();
      const source = join(this.resources, 'payload/metawork');
      const node = join(source, 'desktop-tools/node/bin/node');
      const env = { ...process.env };
      for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'METAWORK_DESKTOP_DEVELOPMENT']) delete env[key];
      if (release.development) env.METAWORK_DESKTOP_INTERNAL = '1';
      env.PATH = [join(source, 'desktop-tools/node/bin'), join(source, 'desktop-tools/git/bin'),
        join(source, 'desktop-tools/executor/bin'), '/usr/bin', '/bin'].join(':');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [join(source, 'dist/desktop-install-cli.js'), command, this.resources, this.root, this.version],
          { env, cwd: this.resources, stdio: ['pipe', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installation failed')));
        child.stdin.on('error', () => undefined);
        child.stdin.end(provider ? JSON.stringify(provider) : '');
      });
    } finally { this.installing = false; }
  }
}
