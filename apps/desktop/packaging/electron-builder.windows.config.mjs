import { resolve } from 'node:path';
import { cp, readFile } from 'node:fs/promises';
import { verifyDesktopRelease } from '../dist/release-tools.mjs';

const resources = process.env.METAWORK_DESKTOP_RESOURCES;
if (!resources || process.env.METAWORK_DESKTOP_INTERNAL !== '1') {
  throw new Error('Windows candidate packaging requires an explicit internal build and verified resources');
}

// The same candidate configuration emits both an unpacked tree for direct
// smoke and a current-user NSIS installer. The installer never owns Server
// lifecycle or account data; those actions remain in the Desktop shell and
// native updater.
export default {
  appId: 'com.metawork.desktop', productName: 'MetaWork', asar: true, npmRebuild: false,
  artifactName: 'MetaWork-win32-${arch}-setup.${ext}', directories: { output: 'release/windows' },
  files: ['dist/main.js', 'dist/preload.cjs', 'shell/**', 'package.json'],
  // Copy the sealed tree ourselves: Builder's walker unconditionally drops
  // .gitkeep/.DS_Store, including files inside bundled third-party tools.
  // The signed inventory must describe exactly what reaches the installer.
  afterPack: async context => {
    const destination = resolve(context.appOutDir, 'resources');
    for (const name of ['desktop-release.json', 'trusted-release-keys.json', 'payload']) {
      await cp(resolve(resources, name), resolve(destination, name), { recursive: true });
    }
    const trustedKeys = JSON.parse(await readFile(resolve(resources, 'trusted-release-keys.json'), 'utf8'));
    await verifyDesktopRelease(destination, { trustedKeys, platform: 'win32', arch: 'x64',
      desktopVersion: context.packager.appInfo.version, allowDevelopment: true });
  },
  forceCodeSigning: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'dir', arch: ['x64'] }], signAndEditExecutable: false },
  nsis: {
    include: 'packaging/windows-installer.nsh',
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'MetaWork',
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  beforePack: async context => {
    if (process.platform !== 'win32' || process.arch !== 'x64' || context.arch !== 1) {
      throw new Error('Windows Desktop requires a native Windows x64 builder');
    }
    const trustedKeys = JSON.parse(await readFile(resolve(resources, 'trusted-release-keys.json'), 'utf8'));
    await verifyDesktopRelease(resolve(resources), { trustedKeys, platform: 'win32', arch: 'x64',
      desktopVersion: context.packager.appInfo.version, allowDevelopment: true });
  },
};
