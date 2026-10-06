import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { verifyDesktopRelease } from './installation/desktop-release.js';
import { SourceNativeInstaller } from './installation/source-native-installer.js';
import { SourceNativeUpdater } from './installation/source-native-updater.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import { createProductionSecretStore } from './configuration/production-secret-store.js';
import { commandExistsOnPath } from './configuration/production-configuration-probe.js';
import { isInstanceRunning } from './management/lock.js';
import { acquireRuntimeUpdateLock } from './installation/runtime-update-lock.js';
import { ensureInternalLlmProvisioned } from './configuration/internal-llm-provisioning.js';

const ProviderSchema = z.object({
  baseUrl: z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  apiKey: z.string().trim().min(1).max(8192), modelId: z.string().trim().min(1).max(256),
}).strict();

async function main(): Promise<void> {
  const [command, resourcesArg, rootArg, desktopVersion] = process.argv.slice(2);
  if (!['install', 'update', 'rollback'].includes(command ?? '') || !resourcesArg || !rootArg || !desktopVersion) {
    throw new Error('Invalid desktop installer arguments');
  }
  const resources = resolve(resourcesArg);
  const trustedKeys = JSON.parse(await readFile(join(resources, 'trusted-release-keys.json'), 'utf8')) as Record<string, string>;
  const release = await verifyDesktopRelease(resources, { trustedKeys, arch: process.arch, desktopVersion,
    allowDevelopment: process.env.METAWORK_DESKTOP_DEVELOPMENT === '1' });
  const paths = resolveMetaWorkPaths(undefined, resolve(rootArg));
  const running = () => isInstanceRunning(join(paths.data, 'runtime.lock'));
  if (await running()) throw new Error('Server must finish its formal stop before installation');
  const sourceRoot = join(resources, 'payload', 'metawork');
  const plannerRoot = join(resources, 'payload', 'planner');
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
  const searchPath = [join(sourceRoot, 'desktop-tools/node/bin'), join(sourceRoot, 'desktop-tools/git/bin'),
    join(sourceRoot, 'desktop-tools/executor/bin'), '/usr/bin', '/bin'].join(':');
  const detectCommand = (name: string) => commandExistsOnPath(name, searchPath);
  if (command === 'install') {
    let body = '';
    for await (const chunk of process.stdin) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 16384) throw new Error('Setup input exceeds limit');
    }
    const provider = ProviderSchema.parse(JSON.parse(body));
    body = '';
    const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
    try {
      await new SourceNativeInstaller({ paths, secretStore, detectCommand, installLaunchers: false }).install({
        releaseId: release.releaseId, sourceRoot, plannerRoot, executorPreset: 'desktop-pi',
        provider: { ...provider, region: 'international', secretReference: 'file-secret:anyfusion/providers/provider' },
      });
      await ensureInternalLlmProvisioned({ installRoot: paths.root });
    } finally { await lock.release(); }
  } else {
    const updater = new SourceNativeUpdater({ paths, secretStore, detectCommand, isServerRunning: running, installLaunchers: false });
    if (command === 'update') {
      await updater.update({ releaseId: release.releaseId, sourceRoot, plannerRoot });
      await ensureInternalLlmProvisioned({ installRoot: paths.root });
    } else await updater.rollback(release.releaseId);
  }
  process.stdout.write(JSON.stringify({ ok: true, releaseId: release.releaseId }) + '\n');
}

void main().catch(() => {
  // Installation errors can contain provider configuration; never echo them to Electron or logs.
  process.stderr.write('Desktop installation did not complete. The previous installation is preserved where recovery prerequisites pass.\n');
  process.exitCode = 1;
});
