/**
 * Release gate for Desktop background updates.
 *
 * Installs the release that is currently on this machine into a disposable root,
 * then applies a candidate payload's `payload/` trees through the real
 * `SourceNativeUpdater.update()` — the exact step that failed with an
 * unclassified `updateRuntime` error when an internal release id exhausted the
 * configuration-reference grammar.
 *
 * Run: node_modules/.bin/vite-node scripts/desktop-update-gate.ts <payload-resources> <previous-install-root>
 * (scripts/verify-desktop-update.mjs wraps this and asserts the result.)
 */
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { SourceNativeInstaller } from '../src/installation/source-native-installer.js';
import { SourceNativeUpdater } from '../src/installation/source-native-updater.js';
import { resolveMetaWorkPaths } from '../src/installation/paths.js';
import { createProductionSecretStore } from '../src/configuration/production-secret-store.js';
import { commandExistsOnPath } from '../src/configuration/production-configuration-probe.js';
import { isValidConfigurationRevisionId } from '../src/configuration/revision-id.js';

const resources = resolve(process.argv[2] ?? '');
const previousRoot = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: desktop-update-gate.ts <payload-resources> <previous-install-root>');

const tools = ['node', 'git', 'executor']
  .map(name => join(resources, 'payload', 'metawork', 'desktop-tools', name, 'bin')).join(':');
process.env.PATH = `${tools}:${process.env.PATH ?? '/usr/bin:/bin'}`;
// The fixture is disposable, so an isolated install and config home is required.
const scratch = '/tmp/metawork-desktop-update-gate';
// Installed tool trees are read-only, so a previous run cannot be removed as-is.
await promisify(execFile)('chmod', ['-R', 'u+w', scratch]).catch(() => undefined);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
Object.assign(process.env, {
  METAWORK_INSTALL_ROOT: scratch,
  ANYFUSION_INSTALL_ROOT: scratch,
  METAWORK_CONFIG_HOME: join(scratch, 'user-config'),
  ANYFUSION_CONFIG_HOME: join(scratch, 'user-config'),
  METAWORK_SECRET_STORE: 'file',
  ANYFUSION_SECRET_STORE: 'file',
});
const paths = resolveMetaWorkPaths(undefined, scratch);
const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
const detectCommand = (name: string) => commandExistsOnPath(name, process.env.PATH!);
const previousReleaseId = JSON.parse(
  await readFile(join(previousRoot, 'app/current/release-identity.json'), 'utf8')).releaseId;

await new SourceNativeInstaller({ paths, secretStore, detectCommand, installLaunchers: false }).install({
  releaseId: previousReleaseId,
  sourceRoot: join(previousRoot, 'app/current'),
  executorPreset: 'desktop-pi',
  provider: {
    baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat', apiKey: 'gate-fixture',
    region: 'international', secretReference: 'file-secret:anyfusion/providers/provider',
  },
});
const candidateReleaseId = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8')).releaseId;
const result = await new SourceNativeUpdater({
  paths, secretStore, isServerRunning: () => false, installLaunchers: false, detectCommand,
}).update({
  releaseId: candidateReleaseId,
  sourceRoot: join(resources, 'payload', 'metawork'),
  memoryRoot: join(resources, 'payload', 'memory', 'tdai'),
});
if (!isValidConfigurationRevisionId(result.upgradeId)) {
  throw new Error(`upgrade id is outside the configuration reference grammar: ${result.upgradeId}`);
}
const identity = JSON.parse(await readFile(join(scratch, 'app/current/release-identity.json'), 'utf8')).releaseId;
if (identity !== candidateReleaseId) throw new Error(`app/current is ${identity}, expected ${candidateReleaseId}`);
const engine = await access(join(await realpath(join(scratch, 'app/current')), 'memory/tdai/package.json'))
  .then(() => true, () => false);
if (!engine) throw new Error('candidate release is missing the bundled memory engine');
process.stdout.write(`desktop update gate: ${previousReleaseId} -> ${candidateReleaseId}, upgradeId ${result.upgradeId}, memory engine present\n`);
