import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopReleaseSchema, desktopInventory, verifyDesktopRelease } from '../../src/installation/desktop-release.js';
import { canonicalizeReleaseManifestPayload } from '../../src/installation/release-manifest.js';

const roots: string[] = [];
const keys = generateKeyPairSync('ed25519');
const trustedKeys = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const options = { trustedKeys, platform: 'win32', arch: 'x64', desktopVersion: '0.1.5' };
const signed = (value: object) => ({ ...value, signature: { algorithm: 'ed25519', keyId: 'fixture',
  value: sign(null, Buffer.from(canonicalizeReleaseManifestPayload(value)), keys.privateKey).toString('base64') } });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Bounded PE header fixture, never executed. Runtime closure is verified by the native build/clean-machine gates.
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
  return bytes;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mw-win-release-')); roots.push(root);
  const payload = join(root, 'payload');
  for (const file of ['metawork/dist/index.js', 'metawork/dist/desktop-install-cli.js',
    'metawork/dist/desktop-update-cli.js', 'metawork/web/dist/index.html', 'planner/packages/coding-agent/dist/cli.js',
    'metawork/desktop-tools/node/node.exe', 'metawork/desktop-tools/git/cmd/git.exe',
    'metawork/desktop-tools/git/bin/bash.exe', 'metawork/dist/pi-pdf/python/python.exe', 'metawork/dist/pi-pdf/index.ts',
    'metawork/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'metawork/native/windows/metawork-platform.node',
    'metawork/desktop-tools/executor/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    ...['node', 'git', 'executor'].map(tool => `metawork/desktop-tools/${tool}/LICENSE`)]) {
    const path = join(payload, file); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, /\.(exe|node)$/u.test(file) ? pe() : 'fixture');
  }
  const artifact = { source: 'https://example.com/source.git', revision: 'a'.repeat(40), url: 'https://example.com/release.zip', byteSize: 1, sha256: 'b'.repeat(64) };
  const runtimeManifest = signed({ manifestSchemaVersion: 1, releaseId: '0.1.5', channel: 'stable',
    publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    minimumInstallerVersion: '0.1.0', minimumNodeVersion: '22.19.0', platform: 'win32', arch: 'x64',
    metawork: artifact, planner: artifact, previousCompatibleRelease: null,
    compatibility: { configurationSchema: 2, plannerHostProtocol: 2, planningPlanSchema: 8,
      planningPlanSchemaHash: 'schema-hash', workGraphSchema: 7, kernelDecisionSchema: 6, databaseSchema: 47 } });
  const descriptor = { schemaVersion: 1, releaseId: '0.1.5', desktopVersion: '0.1.5', electronVersion: '44.5.1',
    platform: 'win32', arch: 'x64', sourceCommit: 'a'.repeat(40), development: false,
    nodeVersion: '22.23.3', nodeAbi: '127', gatewayProtocolVersion: 2, capabilities: ['desktop-session-v1'],
    runtimeManifest, files: await desktopInventory(payload, 'win32') };
  const seal = async () => {
    descriptor.files = await desktopInventory(payload, 'win32');
    await writeFile(join(root, 'desktop-release.json'), JSON.stringify(signed(descriptor)));
  };
  await seal();
  return { root, payload, descriptor, seal };
}

describe('Windows Desktop release admission', () => {
  it('verifies signed x64 PE inventory independently of POSIX executable modes', async () => {
    const value = await fixture();
    await expect(verifyDesktopRelease(value.root, options)).resolves.toMatchObject({ platform: 'win32', arch: 'x64' });
    expect(value.descriptor.files['metawork/desktop-tools/node/node.exe']).toMatchObject({ format: 'pe-x64' });
    expect(value.descriptor.files['metawork/desktop-tools/node/node.exe']).not.toHaveProperty('executable');
    await expect(verifyDesktopRelease(value.root, { ...options, platform: 'darwin' })).rejects.toThrow('compatibility');
    await expect(verifyDesktopRelease(value.root, { ...options, arch: 'arm64' })).rejects.toThrow('compatibility');
    value.descriptor.arch = 'arm64';
    expect(() => DesktopReleaseSchema.parse(signed(value.descriptor))).toThrow();
  });

  it('rejects data disguised as an executable, x86/arm64 images and truncated PE headers', async () => {
    const value = await fixture();
    for (const bytes of [Buffer.from('not PE'), pe(0x14c), pe(0xaa64), pe().subarray(0, 155)]) {
      await writeFile(join(value.payload, 'metawork/desktop-tools/node/node.exe'), bytes);
      await expect(desktopInventory(value.payload, 'win32')).rejects.toThrow(/PE/u);
    }
  });

  it('rejects signed packages missing the native adapter or licenses and detects modifications', async () => {
    const value = await fixture();
    const native = join(value.payload, 'metawork/native/windows/metawork-platform.node');
    await rm(native); await value.seal();
    await expect(verifyDesktopRelease(value.root, options)).rejects.toThrow('dependency is missing');
    await writeFile(native, pe()); await rm(join(value.payload, 'metawork/desktop-tools/git/LICENSE')); await value.seal();
    await expect(verifyDesktopRelease(value.root, options)).rejects.toThrow('license');
    await writeFile(join(value.payload, 'metawork/dist/index.js'), 'tampered');
    await expect(verifyDesktopRelease(value.root, options)).rejects.toThrow('integrity');
  });

  it('rejects Windows path aliases and macOS file metadata in the signed descriptor', async () => {
    const value = await fixture();
    const raw = JSON.parse(await readFile(join(value.root, 'desktop-release.json'), 'utf8'));
    for (const path of ['C:/outside', 'dir/CON.txt', 'dir/file:stream', 'dir/trailing.', 'dir/trailing ', '../outside']) {
      expect(() => DesktopReleaseSchema.parse({ ...raw, files: { [path]: { sha256: 'a'.repeat(64), size: 1, format: 'data' } } })).toThrow();
    }
    expect(() => DesktopReleaseSchema.parse({ ...raw, files: { 'file.txt': { sha256: 'a'.repeat(64), size: 1, executable: true } } })).toThrow();
  });
});
