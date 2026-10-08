import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Keep npm's Electron intact; macOS reads native identity from the .app bundle. */
export async function prepareDevelopmentShell() {
  const electronDist = join(desktop, 'node_modules/electron/dist');
  const binary = (await readFile(join(desktop, 'node_modules/electron/path.txt'), 'utf8')).trim();
  if (process.platform !== 'darwin') return join(electronDist, binary);

  const sourceApp = join(electronDist, 'Electron.app');
  const sourceInfo = await readFile(join(sourceApp, 'Contents/Info.plist'));
  // A new cache path avoids modifying an already running development shell.
  const iconPath = join(desktop, 'assets/metawork.icns');
  const fingerprint = createHash('sha256').update(sourceInfo).update(process.arch).update(await readFile(iconPath)).digest('hex').slice(0, 16);
  const cache = join(desktop, '../../.tmp/desktop-shell', fingerprint);
  const application = join(cache, 'MetaWork.app');
  // Preserve Electron's development-mode detection (app.isPackaged === false).
  // The bundle name/display name, not this private executable name, labels the Dock.
  const executable = join(application, 'Contents/MacOS/Electron');
  const marker = join(cache, 'ready.json');
  if (await readFile(marker, 'utf8').then(value => JSON.parse(value).fingerprint === fingerprint, () => false)) return executable;

  const staging = `${cache}-${randomUUID()}`;
  const stagedApp = join(staging, 'MetaWork.app');
  await mkdir(staging, { recursive: true });
  try {
    await execute('/usr/bin/ditto', [sourceApp, stagedApp]);
    const infoPath = join(stagedApp, 'Contents/Info.plist');
    const info = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath])).stdout);
    Object.assign(info, {
      CFBundleName: 'MetaWork', CFBundleDisplayName: 'MetaWork',
      CFBundleIdentifier: 'com.metawork.desktop.development',
      CFBundleIconFile: 'metawork.icns',
    });
    await cp(iconPath, join(stagedApp, 'Contents/Resources/metawork.icns'));
    await writeFile(infoPath, JSON.stringify(info));
    await execute('/usr/bin/plutil', ['-convert', 'xml1', infoPath]);
    // Local development signature only; release signing/notarization stays separate.
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', stagedApp]);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    await writeFile(join(staging, 'ready.json'), JSON.stringify({ fingerprint }));
    await mkdir(dirname(cache), { recursive: true });
    try { await rename(staging, cache); }
    catch (error) {
      // Two launchers may prepare the same immutable shell concurrently.
      if (!(await readFile(marker, 'utf8').then(value => JSON.parse(value).fingerprint === fingerprint, () => false))) throw error;
    }
    return executable;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
