import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { verifyDesktopRelease } from './installation/desktop-release.js';
import { SourceNativeInstaller } from './installation/source-native-installer.js';
import { SourceNativeUpdater } from './installation/source-native-updater.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import { createProductionSecretStore } from './configuration/production-secret-store.js';
import { commandExistsOnPath } from './configuration/production-configuration-probe.js';
import { isInstanceRunning } from './management/lock.js';
import { acquireRuntimeUpdateLock } from './installation/runtime-update-lock.js';
import { desktopProcessEnvironment, desktopToolPaths } from './installation/desktop-platform.js';
import { loadWindowsPrivateFiles } from './platform/windows-private-files.js';

const ProviderSchema = z.object({
  baseUrl: z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  apiKey: z.string().trim().min(1).max(8192), modelId: z.string().trim().min(1).max(256),
}).strict();

export async function runDesktopInstall(
  argv: string[],
  input: AsyncIterable<string | Buffer> = process.stdin,
): Promise<void> {
  const [command, resourcesArg, rootArg, desktopVersion] = argv;
  if (!['install', 'update', 'rollback'].includes(command ?? '') || !resourcesArg || !rootArg || !desktopVersion) {
    throw new Error('Invalid desktop installer arguments');
  }
  const resources = resolve(resourcesArg);
  const trustedKeys = JSON.parse(await readFile(join(resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
  const release = await verifyDesktopRelease(resources, { trustedKeys, platform: process.platform, arch: process.arch, desktopVersion,
    allowDevelopment: process.env.METAWORK_DESKTOP_INTERNAL === '1' });
  const paths = resolveMetaWorkPaths(undefined, resolve(rootArg));
  const sourceRoot = join(resources, 'payload', 'metawork');
  const windows = process.platform === 'win32' ? {
    root: paths.root, files: loadWindowsPrivateFiles(join(sourceRoot, 'native/windows/metawork-platform.node')),
  } : undefined;
  // Protect the root before the lock, credentials, database or release staging
  // can create children with inherited Windows permissions.
  windows?.files.ensurePrivateDirectory(paths.root);
  const running = () => isInstanceRunning(join(paths.data, 'runtime.lock'));
  if (await running()) throw new Error('Server must finish its formal stop before installation');
  const plannerRoot = join(resources, 'payload', 'planner');
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials, windows });
  const searchPath = desktopProcessEnvironment({ releaseRoot: sourceRoot,
    nodePath: desktopToolPaths(sourceRoot).node, env: process.env }).PATH!;
  const detectCommand = (name: string) => commandExistsOnPath(name, searchPath);
  if (command === 'install') {
    let body = '';
    for await (const chunk of input) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 16384) throw new Error('Setup input exceeds limit');
    }
    const provider = ProviderSchema.parse(JSON.parse(body));
    body = '';
    const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
    try {
      await new SourceNativeInstaller({ paths, secretStore, detectCommand, installLaunchers: false, windows }).install({
        releaseId: release.releaseId, sourceRoot, plannerRoot, executorPreset: 'desktop-pi',
        provider: { ...provider, region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' },
      });
    } finally { await lock.release(); }
  } else {
    const updater = new SourceNativeUpdater({ paths, secretStore, detectCommand, isServerRunning: running, installLaunchers: false });
    if (command === 'update') {
      await updater.update({ releaseId: release.releaseId, sourceRoot, plannerRoot });
    } else await updater.rollback(release.releaseId);
  }
  process.stdout.write(JSON.stringify({ ok: true, releaseId: release.releaseId }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runDesktopInstall(process.argv.slice(2)).catch(() => {
    // Installation errors can contain provider configuration; never echo them to Electron or logs.
    process.stderr.write('Desktop installation did not complete. The previous installation is preserved where recovery prerequisites pass.\n');
    process.exitCode = 1;
  });
}
