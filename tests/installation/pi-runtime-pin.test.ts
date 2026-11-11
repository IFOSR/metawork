import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPiRuntimePin, probePiRuntimePin } from '../../scripts/lib/pi-runtime-pin.mjs';

// ADR-0055 D6: the packaged Manager and Executor run the upstream Pi version the
// packaging host has installed. The build must prove which version that is and
// fail when it is missing or mismatched.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeManagedPi(options: { version?: string; packageVersion?: string; engine?: string } = {}) {
  const version = options.version ?? '9.9.9';
  const root = mkdtempSync(join(tmpdir(), 'pi-pin-'));
  roots.push(root);
  const releaseDir = join(root, 'install', 'releases', version);
  const packageDir = join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: options.packageVersion ?? version,
    engines: { node: options.engine ?? '>=22.19.0' },
  }));
  writeFileSync(join(releaseDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, 'pi');
  writeFileSync(launcher, `#!/bin/sh\nprintf '${version}\\n'\n`);
  chmodSync(launcher, 0o755);
  return { root: realpathSync(root), launcher, version };
}

describe('packaged Pi runtime pin', () => {
  it('records the managed version, package and lock witness', () => {
    const fake = fakeManagedPi({ version: '1.5.0' });
    const pin = probePiRuntimePin({ command: fake.launcher });
    expect(pin).toMatchObject({
      version: '1.5.0',
      packageName: '@earendil-works/pi-coding-agent',
      packageVersion: '1.5.0',
      nodeEngine: '>=22.19.0',
      agentRoot: fake.root,
      releaseDir: join(fake.root, 'install', 'releases', '1.5.0'),
    });
    expect(pin.lockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertPiRuntimePin({ command: fake.launcher, hostNodeVersion: '22.23.3' })).not.toThrow();
  });

  it('fails when the launcher version and the installed package disagree', () => {
    const fake = fakeManagedPi({ version: '1.5.0', packageVersion: '1.4.0' });
    expect(() => probePiRuntimePin({ command: fake.launcher })).toThrow(/version mismatch/u);
  });

  it('fails when Pi is not installed', () => {
    expect(() => probePiRuntimePin({ command: '/nonexistent/pi' })).toThrow();
  });

  it('fails when the host Node is older than the packaged Pi requires', () => {
    const fake = fakeManagedPi({ version: '1.5.0', engine: '>=23.0.0' });
    expect(() => assertPiRuntimePin({ command: fake.launcher, hostNodeVersion: '22.23.3' }))
      .toThrow(/requires Node/u);
  });

  it('probes the real host Pi when it is installed under the managed layout', () => {
    let realLauncher: string | null = null;
    try {
      realLauncher = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    } catch { /* no Pi on this host */ }
    if (!realLauncher) return;
    const pin = probePiRuntimePin({ command: realLauncher });
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(pin.packageVersion).toBe(pin.version);
    expect(dirname(pin.releaseDir)).toBe(join(pin.agentRoot, 'install', 'releases'));
  });
});
