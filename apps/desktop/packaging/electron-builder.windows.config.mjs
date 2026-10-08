import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { verifyDesktopRelease } from '../dist/release-tools.mjs';

const resources = process.env.METAWORK_DESKTOP_RESOURCES;
if (!resources || process.env.METAWORK_DESKTOP_INTERNAL !== '1') {
  throw new Error('Windows candidate packaging requires an explicit internal build and verified resources');
}

// Packaged EXE acceptance precedes NSIS integration. This configuration emits
// only an unpacked application; it cannot overwrite a user's existing shell.
export default {
  appId: 'com.metawork.desktop', productName: 'MetaWork', asar: true, npmRebuild: false,
  artifactName: 'MetaWork-win32-${arch}.${ext}', directories: { output: 'release/windows' },
  files: ['dist/main.js', 'dist/preload.cjs', 'shell/**', 'package.json'],
  extraResources: [{ from: resolve(resources), to: '.', filter: ['desktop-release.json', 'trusted-release-keys.json', 'payload/**'] }],
  forceCodeSigning: false,
  win: { target: [{ target: 'dir', arch: ['x64'] }], signAndEditExecutable: false },
  beforePack: async context => {
    if (process.platform !== 'win32' || process.arch !== 'x64' || context.arch !== 1) {
      throw new Error('Windows Desktop requires a native Windows x64 builder');
    }
    const trustedKeys = JSON.parse(await readFile(resolve(resources, 'trusted-release-keys.json'), 'utf8'));
    await verifyDesktopRelease(resolve(resources), { trustedKeys, platform: 'win32', arch: 'x64',
      desktopVersion: context.packager.appInfo.version, allowDevelopment: true });
  },
};
