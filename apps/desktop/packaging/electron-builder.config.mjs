import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { verifyDesktopRelease } from '../dist/release-tools.mjs';

const resources = process.env.METAWORK_DESKTOP_RESOURCES;
if (!resources) throw new Error('Set METAWORK_DESKTOP_RESOURCES to the verified Runtime payload');
const internal = process.env.METAWORK_DESKTOP_INTERNAL === '1';
if (!internal && (!process.env.CSC_NAME || !process.env.METAWORK_NOTARY_PROFILE)) throw new Error('Developer ID signing identity and notarytool profile are required');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} did not complete`);
}
export default {
  appId: 'com.metawork.desktop', productName: 'MetaWork', asar: true, npmRebuild: false,
  artifactName: 'MetaWork-darwin-${arch}.${ext}',
  directories: { output: 'release' },
  files: ['dist/main.js', 'dist/preload.cjs', 'shell/**', 'package.json'],
  extraResources: [{ from: resolve(resources), to: '.', filter: ['desktop-release.json', 'trusted-release-keys.json', 'payload/**'] }],
  forceCodeSigning: !internal,
  mac: { target: ['dmg'], category: 'public.app-category.productivity', hardenedRuntime: !internal,
    entitlements: 'packaging/entitlements.mac.plist', entitlementsInherit: 'packaging/entitlements.mac.plist',
    // The Runtime is independently verified and pre-signed before its inventory is signed.
    signIgnore: ['.*\/Resources\/payload\/.*'], notarize: false },
  dmg: { sign: !internal },
  beforePack: async context => {
    if (process.platform !== 'darwin') throw new Error('Desktop release requires a native macOS builder');
    const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : 'unsupported';
    if (arch !== process.arch) throw new Error('Each architecture requires its own native validation runner');
    const trustedKeys = JSON.parse(await readFile(resolve(resources, 'trusted-release-keys.json'), 'utf8'));
    await verifyDesktopRelease(resolve(resources), { trustedKeys, platform: process.platform, arch, desktopVersion: context.packager.appInfo.version, allowDevelopment: internal });
  },
  afterSign: internal ? undefined : async context => {
    const app = resolve(context.appOutDir, 'MetaWork.app');
    const archive = resolve(context.appOutDir, 'MetaWork-notary.zip');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
    run('/usr/bin/xcrun', ['notarytool', 'submit', archive, '--keychain-profile', process.env.METAWORK_NOTARY_PROFILE, '--wait']);
    run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', app]);
  },
  afterAllArtifactBuild: internal ? undefined : async result => {
    for (const artifact of result.artifactPaths.filter(path => path.endsWith('.dmg'))) {
      run('/usr/bin/xcrun', ['notarytool', 'submit', artifact, '--keychain-profile', process.env.METAWORK_NOTARY_PROFILE, '--wait']);
      run('/usr/bin/xcrun', ['stapler', 'staple', artifact]);
      run('/usr/bin/xcrun', ['stapler', 'validate', artifact]);
    }
    return [];
  },
};
