import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackage } from '@electron/asar';
import { build } from 'esbuild';
import { desktopInventory, verifyDesktopRelease } from '../dist/release-tools.mjs';

// Local acceptance only. Ephemeral signatures are never a distributable release.
const source = resolve(process.argv[2] ?? 'apps/desktop/release/mac-arm64/MetaWork.app');
const root = resolve(process.argv[3] ?? '.tmp/desktop-adoption-acceptance');
const application = join(root, 'MetaWork.app');
await mkdir(root, { recursive: true });
await cp(source, application, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
const resources = join(application, 'Contents/Resources');
await cp(resolve('dist'), join(resources, 'payload/metawork/dist'), { recursive: true });
const shell = join(root, 'shell-package');
await mkdir(shell);
for (const name of ['dist', 'shell', 'package.json']) {
  await cp(resolve('apps/desktop', name), join(shell, name), { recursive: true });
}
await createPackage(shell, join(resources, 'app.asar'));
const keys = generateKeyPairSync('ed25519');
await build({ stdin: { contents: `
export { SourceNativeInstaller } from './src/installation/source-native-installer.ts';
export { resolveMetaWorkPaths } from './src/installation/paths.ts';
export { createProductionSecretStore } from './src/configuration/production-secret-store.ts';
export { DesktopServiceManager } from './src/client/desktop-service-manager.ts';
export { commandExistsOnPath } from './src/configuration/production-configuration-probe.ts';
export { canonicalizeReleaseManifestPayload } from './src/installation/release-manifest.ts';
`, resolveDir: process.cwd() }, outfile: join(root, 'fixture-tools.mjs'), bundle: true, platform: 'node', format: 'esm',
  external: ['better-sqlite3'], target: 'node22' });
const { canonicalizeReleaseManifestPayload } = await import(pathToFileURL(join(root, 'fixture-tools.mjs')).href);
function signed(value) {
  const { signature: _, ...body } = value;
  return { ...body, signature: { algorithm: 'ed25519', keyId: 'local-acceptance',
    value: sign(null, Buffer.from(canonicalizeReleaseManifestPayload(body)), keys.privateKey).toString('base64') } };
}
let descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
descriptor.runtimeManifest = signed(descriptor.runtimeManifest);
descriptor.files = await desktopInventory(join(resources, 'payload'));
descriptor = signed(descriptor);
const trustedKeys = { 'local-acceptance': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
await writeFile(join(resources, 'desktop-release.json'), JSON.stringify(descriptor));
await writeFile(join(resources, 'trusted-release-keys.json'), JSON.stringify(trustedKeys));
await verifyDesktopRelease(resources, { trustedKeys, arch: process.arch, desktopVersion: descriptor.desktopVersion, allowDevelopment: true });
// Replacing asar/resources invalidates the shell's ad-hoc seal. macOS network
// helpers need a valid app seal even for an internal, non-Developer-ID fixture.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', application], { stdio: 'pipe' });
console.log(`Prepared isolated adoption fixture: ${root}`);
