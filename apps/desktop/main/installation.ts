import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDesktopRelease, type DesktopRelease } from '../../../src/installation/desktop-release.js';
import { desktopProcessEnvironment, desktopToolPaths } from '../../../src/installation/desktop-platform.js';
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
    this.release = await verifyDesktopRelease(this.resources, { trustedKeys: keys, platform: process.platform, arch: process.arch,
      desktopVersion: this.version, allowDevelopment: descriptor.development === true });
    return this.release;
  }
  async installed(): Promise<boolean> {
    return access(join(this.root, 'app/current/release-identity.json')).then(() => true, () => false);
  }
  async nodePath(): Promise<string> {
    return realpath(desktopToolPaths(join(this.root, 'app/current')).node);
  }
  async run(command: 'install' | 'update' | 'rollback', provider?: DesktopSetupInput): Promise<void> {
    if (this.installing) throw new Error('Installation already in progress');
    this.installing = true;
    try {
      this.release = null;
      const release = await this.verify();
      const source = join(this.resources, 'payload/metawork');
      const node = desktopToolPaths(source).node;
      const env = desktopProcessEnvironment({ releaseRoot: source, nodePath: node, env: process.env });
      delete env.METAWORK_DESKTOP_DEVELOPMENT;
      if (release.development) env.METAWORK_DESKTOP_INTERNAL = '1';
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [join(source, 'dist/desktop-install-cli.js'), command, this.resources, this.root, this.version],
          { env, cwd: this.resources, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installation failed')));
        child.stdin.on('error', () => undefined);
        child.stdin.end(provider ? JSON.stringify(provider) : '');
      });
    } finally { this.installing = false; }
  }
}
