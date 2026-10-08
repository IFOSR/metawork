import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDesktopRelease, type DesktopRelease } from '../../../src/installation/desktop-release.js';
import { desktopProcessEnvironment, desktopToolPaths } from '../../../src/installation/desktop-platform.js';
import type { DesktopSetupInput } from '../shared/bridge.js';
import { allowDevelopmentPayload } from '../shared/build-policy.js';
import { desktopInstallPhases, type DesktopInstallPhase } from '../../../src/installation/desktop-install-progress.js';

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
      desktopVersion: this.version, allowDevelopment: allowDevelopmentPayload(descriptor.development === true) });
    return this.release;
  }
  async installed(): Promise<boolean> {
    return access(join(this.root, 'app/current/release-identity.json')).then(() => true, () => false);
  }
  async nodePath(): Promise<string> {
    return realpath(desktopToolPaths(join(this.root, 'app/current')).node);
  }
  async run(command: 'install' | 'update' | 'rollback', provider?: DesktopSetupInput,
    onProgress?: (phase: DesktopInstallPhase) => void): Promise<void> {
    if (this.installing) throw new Error('Installation already in progress');
    this.installing = true;
    try {
      onProgress?.('verifying');
      this.release = null;
      const release = await this.verify();
      const source = join(this.resources, 'payload/metawork');
      const node = desktopToolPaths(source).node;
      const env = desktopProcessEnvironment({ releaseRoot: source, nodePath: node, env: process.env });
      delete env.METAWORK_DESKTOP_DEVELOPMENT;
      if (release.development) env.METAWORK_DESKTOP_INTERNAL = '1';
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, [join(source, 'dist/desktop-install-cli.js'), command, this.resources, this.root, this.version],
          { env, cwd: this.resources, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data: string) => {
          output += data;
          if (output.length > 4096) { output = ''; return; }
          const lines = output.split('\n'); output = lines.pop()!;
          for (const line of lines) {
            try {
              const value = JSON.parse(line) as { phase?: DesktopInstallPhase };
              if (value.phase && desktopInstallPhases.includes(value.phase)) onProgress?.(value.phase);
            } catch { /* Only fixed progress phases are presented to the shell. */ }
          }
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installation failed')));
        child.stdin.on('error', () => undefined);
        child.stdin.end(provider ? JSON.stringify(provider) : '');
      });
    } finally { this.installing = false; }
  }
}
