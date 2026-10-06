import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopInventory, verifyDesktopRelease } from '../../src/installation/desktop-release.js';
import { canonicalizeReleaseManifestPayload } from '../../src/installation/release-manifest.js';

const roots: string[] = [];
const keys = generateKeyPairSync('ed25519');
const trustedKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const signed = (value: object) => ({ ...value, signature: { algorithm: 'ed25519', keyId: 'test',
  value: sign(null, Buffer.from(canonicalizeReleaseManifestPayload(value)), keys.privateKey).toString('base64') } });
async function fixture(development = false) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-release-')); roots.push(root);
  const payload = join(root, 'payload');
  for (const file of ['metawork/dist/index.js', 'metawork/dist/desktop-install-cli.js',
    'metawork/dist/desktop-update-cli.js', 'metawork/web/dist/index.html',
    'metawork/desktop-tools/node/bin/node', 'metawork/desktop-tools/git/bin/git',
    'metawork/desktop-tools/executor/bin/pi', 'planner/packages/coding-agent/dist/cli.js']) {
    const path = join(payload, file); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture', { mode: file.includes('/bin/') ? 0o755 : 0o644 });
  }
  const artifact = { source: 'https://example.com/source.git', revision: 'a'.repeat(40), url: 'https://example.com/release.tgz', byteSize: 1, sha256: 'b'.repeat(64) };
  const runtime = signed({ manifestSchemaVersion: 1, releaseId: '1.0.0', channel: 'stable',
    publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    minimumInstallerVersion: '0.1.0', minimumNodeVersion: '22.19.0', platform: 'darwin', arch: 'arm64',
    metawork: artifact, planner: artifact, previousCompatibleRelease: null,
    compatibility: { configurationSchema: 2, plannerHostProtocol: 2, planningPlanSchema: 8,
      planningPlanSchemaHash: 'schema-hash', workGraphSchema: 7, kernelDecisionSchema: 6, databaseSchema: 47 },
  });
  const release = signed({ schemaVersion: 1, releaseId: '1.0.0', desktopVersion: '0.1.0', electronVersion: '44.5.1',
    platform: 'darwin', arch: 'arm64', sourceCommit: 'a'.repeat(40), development,
    nodeVersion: '22.23.3', nodeAbi: '127', gatewayProtocolVersion: 2, capabilities: ['desktop-session-v1'],
    runtimeManifest: runtime, files: await desktopInventory(payload) });
  await writeFile(join(root, 'desktop-release.json'), JSON.stringify(release));
  return root;
}
const options = { trustedKeys, arch: 'arm64', desktopVersion: '0.1.0' };
describe('Desktop release admission', () => {
  it('rejects even validly signed inventories that cannot install or update', async () => {
    const root = await fixture();
    const descriptor = JSON.parse(await readFile(join(root, 'desktop-release.json'), 'utf8'));
    await chmod(join(root, 'payload/metawork/desktop-tools/node/bin/node'), 0o644);
    descriptor.files = await desktopInventory(join(root, 'payload'));
    await writeFile(join(root, 'desktop-release.json'), JSON.stringify(signed(descriptor)));
    await expect(verifyDesktopRelease(root, options)).rejects.toThrow('not executable');
    await rm(join(root, 'payload/metawork/dist/desktop-update-cli.js'));
    descriptor.files = await desktopInventory(join(root, 'payload'));
    await writeFile(join(root, 'desktop-release.json'), JSON.stringify(signed(descriptor)));
    await expect(verifyDesktopRelease(root, options)).rejects.toThrow('dependency is missing');
  });
  it('accepts a complete signed combination and detects changed or additional payload files', async () => {
    const root = await fixture(); await expect(verifyDesktopRelease(root, options)).resolves.toMatchObject({ releaseId: '1.0.0' });
    await writeFile(join(root, 'payload/metawork/dist/index.js'), 'changed');
    await expect(verifyDesktopRelease(root, options)).rejects.toThrow('integrity');
    await writeFile(join(root, 'payload/metawork/dist/unlisted.js'), 'new');
    await expect(verifyDesktopRelease(root, options)).rejects.toThrow('file set');
  });
  it('rejects development packages in production, architecture mismatch, changed signatures and links', async () => {
    const dev = await fixture(true);
    await expect(verifyDesktopRelease(dev, options)).rejects.toThrow('compatibility');
    await expect(verifyDesktopRelease(dev, { ...options, allowDevelopment: true })).resolves.toBeDefined();
    const root = await fixture();
    await expect(verifyDesktopRelease(root, { ...options, arch: 'x64' })).rejects.toThrow('compatibility');
    const descriptor = JSON.parse(await readFile(join(root, 'desktop-release.json'), 'utf8'));
    descriptor.releaseId = '2.0.0'; await writeFile(join(root, 'desktop-release.json'), JSON.stringify(descriptor));
    await expect(verifyDesktopRelease(root, options)).rejects.toThrow('signature');
    await symlink('/tmp', join(root, 'payload/link'));
    await expect(desktopInventory(join(root, 'payload'))).rejects.toThrow('links');
  });
});
