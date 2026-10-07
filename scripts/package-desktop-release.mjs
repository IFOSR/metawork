import { sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyDesktopRelease, hashReleaseFile } from '../apps/desktop/dist/release-tools.mjs';
import { TRUSTED_KEY_ID, TRUSTED_PUBLIC_KEY, stable } from './verify-release-assets.mjs';

// Run after electron-builder's signature, notarization and stapling hooks succeed.
const [resourcesArg, outputArg, signingKeyPath] = process.argv.slice(2);
if (!resourcesArg || !outputArg || !signingKeyPath) throw new Error('Usage: package-desktop-release.mjs RESOURCES OUTPUT PRIVATE_KEY');
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const release = await verifyDesktopRelease(resolve(resourcesArg), {
  trustedKeys: { [TRUSTED_KEY_ID]: TRUSTED_PUBLIC_KEY }, arch: process.arch, desktopVersion: version,
});
const target = `darwin-${release.arch}`;
const name = `MetaWork-${target}.dmg`;
const output = resolve(outputArg);
const artifact = await hashReleaseFile(join(output, name));
const manifest = {
  schemaVersion: 1, tag: `v${version}`, target, desktopVersion: version,
  releaseId: release.releaseId, sourceCommit: release.sourceCommit, development: false,
  artifact: { name, byteSize: artifact.size, sha256: artifact.sha256 },
};
const signature = { algorithm: 'ed25519', keyId: TRUSTED_KEY_ID,
  value: sign(null, Buffer.from(stable(manifest)), await readFile(signingKeyPath)).toString('base64') };
await writeFile(join(output, `desktop-manifest.${target}.json`), JSON.stringify({ ...manifest, signature }, null, 2) + '\n');
