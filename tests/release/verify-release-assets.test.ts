import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_TARGETS, DESKTOP_TARGETS, TRUSTED_KEY_ID, stable, verifyReleaseAssets, verifyPublishedRelease } from '../../scripts/verify-release-assets.mjs';

const keys = generateKeyPairSync('ed25519');
const options = { trustedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const revision = 'a'.repeat(40);
const tag = 'v0.1.5';
const releaseId = '0.1.5-build-aaaaaaa';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function signed(value: Record<string, unknown>) {
  return { ...value, signature: { algorithm: 'ed25519', keyId: TRUSTED_KEY_ID,
    value: sign(null, Buffer.from(stable(value)), keys.privateKey).toString('base64') } };
}
function fixture(absolute = true) {
  const root = mkdtempSync(join(tmpdir(), 'metawork-release-')); roots.push(root);
  const body = Buffer.from('archive fixture');
  const facts = { byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  for (const target of RELEASE_TARGETS) {
    const [platform, arch] = target.split('-');
    const artifacts: Record<string, unknown> = {};
    for (const kind of ['metawork', 'planner']) {
      const name = `${kind}-${releaseId}-${target}${platform === 'win32' ? '.zip' : '.tar.gz'}`;
      writeFileSync(join(root, name), body);
      artifacts[kind] = { source: 'https://github.com/IFOSR/metawork.git', revision,
        url: absolute ? `https://github.com/IFOSR/metawork/releases/download/${tag}/${name}` : name, ...facts };
    }
    writeFileSync(join(root, `manifest.${target}.json`), JSON.stringify(signed({
      manifestSchemaVersion: 1, channel: 'stable', platform, arch, releaseId, ...artifacts,
      publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
      compatibility: { databaseSchema: 47 }, minimumInstallerVersion: '1.2.0', minimumNodeVersion: '22.19.0',
    })));
  }
  for (const target of DESKTOP_TARGETS) {
    const name = `MetaWork-${target}.dmg`; writeFileSync(join(root, name), body);
    writeFileSync(join(root, `desktop-manifest.${target}.json`), JSON.stringify(signed({
      schemaVersion: 1, target, tag, desktopVersion: '0.1.5', releaseId,
      sourceCommit: revision, development: false, artifact: { name, ...facts },
    })));
  }
  for (const name of ['install.sh', 'install.ps1']) writeFileSync(join(root, name), 'installer fixture');
  return root;
}
describe('complete latest release gate', () => {
  it.each([true, false])('accepts a coherent native/Desktop set (absolute URLs: %s)', async absolute => {
    const release = await verifyReleaseAssets(fixture(absolute), tag, { ...options, sourceCommit: revision });
    expect(release.files).toHaveLength(18);
  });
  it('rejects a missing Desktop architecture instead of publishing a partial release', async () => {
    const root = fixture(); rmSync(join(root, 'MetaWork-darwin-x64.dmg'));
    await expect(verifyReleaseAssets(root, tag, options)).rejects.toThrow();
  });
  it('detects replaced Desktop downloads', async () => {
    const root = fixture(); writeFileSync(join(root, 'MetaWork-darwin-arm64.dmg'), 'modified');
    await expect(verifyReleaseAssets(root, tag, options)).rejects.toThrow('size mismatch');
  });
  it.each(['development', 'sourceCommit', 'desktopVersion'])('rejects signed Desktop metadata with the wrong %s', async field => {
    const root = fixture(); const file = join(root, 'desktop-manifest.darwin-arm64.json');
    const { signature: _signature, ...payload } = JSON.parse(readFileSync(file, 'utf8'));
    payload[field] = field === 'development' ? true : field === 'sourceCommit' ? 'b'.repeat(40) : '0.1.4';
    writeFileSync(file, JSON.stringify(signed(payload)));
    await expect(verifyReleaseAssets(root, tag, options)).rejects.toThrow('identity mismatch');
  });
  it('requires downloadable installers', async () => {
    const root = fixture(); rmSync(join(root, 'install.sh'));
    await expect(verifyReleaseAssets(root, tag, options)).rejects.toThrow();
  });
  it('verifies the actual GitHub latest download URLs without an extra latest segment', async () => {
    const root = fixture(); const release = await verifyReleaseAssets(root, tag, options);
    const base = 'https://github.com/IFOSR/metawork/releases/latest/download';
    const fetch = vi.fn(async (url: string) => {
      expect(url).toMatch(new RegExp(`^${base}/[^/]+$`));
      return new Response(readFileSync(join(root, new URL(url).pathname.split('/').at(-1)!)));
    });
    vi.stubGlobal('fetch', fetch); vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await verifyPublishedRelease(release, base);
    expect(fetch).toHaveBeenCalledTimes(18);
  });
});
