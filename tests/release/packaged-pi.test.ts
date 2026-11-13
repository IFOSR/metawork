import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePackagedPi } from '../../scripts/lib/packaged-pi.mjs';
import { probePiRuntimePin } from '../../scripts/lib/pi-runtime-pin.mjs';
import { writePackagedPiFixture } from '../fixtures/packaged-pi.js';
import { parseReleaseManifest } from '../../src/installation/release-manifest.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.tmp/pi-packaging-')); roots.push(root);
  const host = join(root, 'host');
  const tool = join(root, 'fixture-tool');
  writePackagedPiFixture(tool);
  const release = join(host, 'install/releases/1.5.0');
  mkdirSync(dirname(release), { recursive: true });
  renameSync(join(tool, 'runtime'), release);
  mkdirSync(join(host, 'bin'));
  const command = join(host, 'bin/pi');
  writeFileSync(command, '#!/bin/sh\nprintf "1.5.0\\n"\n', { mode: 0o755 });
  writeFileSync(join(host, 'auth.json'), 'host credentials must never be copied');
  return { root, host, command, pin: probePiRuntimePin({ command }) };
}

describe('packaged upstream Pi delivery', () => {
  it('runs the copied entry after the host installation disappears and survives relocation', async () => {
    const { root, host, pin } = fixture();
    const original = join(root, 'original/executor');
    await stagePackagedPi(pin, original);
    rmSync(host, { recursive: true });
    const moved = join(root, 'moved executor'); renameSync(original, moved);
    const result = execFileSync(join(moved, 'bin/pi'), ['--version'], { encoding: 'utf8' });
    expect(result.trim()).toBe('1.5.0');
    expect(existsSync(join(moved, 'auth.json'))).toBe(false);
    expect(existsSync(join(moved, 'runtime/auth.json'))).toBe(false);
    expect(readFileSync(join(moved, 'bin/pi'), 'utf8')).not.toContain(host);
    // Desktop must select its own sibling Node even when PATH has another one.
    mkdirSync(join(root, 'node/bin'), { recursive: true });
    writeFileSync(join(root, 'node/bin/node'), '#!/bin/sh\nprintf "bundled-node\\n"\n', { mode: 0o755 });
    renameSync(moved, join(root, 'executor'));
    expect(execFileSync(join(root, 'executor/bin/pi'), [], { encoding: 'utf8' }).trim()).toBe('bundled-node');
  });

  it('refuses a changed lockfile before publishing a tool directory', async () => {
    const { root, pin } = fixture();
    writeFileSync(join(pin.releaseDir, 'package-lock.json'), '{}');
    const output = join(root, 'executor');
    await expect(stagePackagedPi(pin, output)).rejects.toThrow('integrity mismatch');
    expect(existsSync(output)).toBe(false);
  });

  it('packages and signs a forkless release whose Pi archive can run independently', () => {
    const { root, command } = fixture();
    const source = join(root, 'source');
    const memory = join(root, 'memory/tdai');
    for (const [file, body] of Object.entries({
      'dist/install-cli.js': '// installer', 'dist/planning-agent-plan-v9.schema.json': '{}',
      'web/dist/index.html': '<html/>', 'package.json': JSON.stringify({ name: 'metawork', version: '1.2.0' }),
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'fixture native binary',
    })) {
      mkdirSync(dirname(join(source, file)), { recursive: true }); writeFileSync(join(source, file), body);
    }
    mkdirSync(join(memory, 'dist/gateway'), { recursive: true });
    writeFileSync(join(memory, 'package.json'), '{}'); writeFileSync(join(memory, 'dist/gateway/server.js'), '// memory');
    const key = join(root, 'signing.pem');
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    chmodSync(key, 0o600);
    const out = join(root, 'artifacts');
    execFileSync(process.execPath, ['scripts/package-release.mjs', '--source-root', source,
      '--memory-root', memory, '--pi-command', command, '--out-dir', out, '--signing-key', key,
      '--release-id', '1.2.0-build-test', '--artifact-base-url', 'https://example.test/releases'], { encoding: 'utf8' });
    const manifest = parseReleaseManifest(JSON.parse(readFileSync(join(out, `manifest.${process.platform}-${process.arch}.json`), 'utf8')));
    expect(manifest.planner).toBeUndefined();
    expect(manifest.pi?.version).toBe('1.5.0');
    const extracted = join(root, 'extracted'); mkdirSync(extracted);
    execFileSync('tar', ['-xzf', join(out, `pi-1.2.0-build-test-${process.platform}-${process.arch}.tar.gz`), '-C', extracted]);
    rmSync(join(root, 'host'), { recursive: true });
    expect(execFileSync(join(extracted, 'pi/bin/pi'), ['--version'], { encoding: 'utf8' }).trim()).toBe('1.5.0');
  });
});
