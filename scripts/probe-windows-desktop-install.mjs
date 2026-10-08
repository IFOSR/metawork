// Formal installer against a verified candidate, isolated from every user install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows runner required');
const [resourcesArg, installArg, evidenceArg] = process.argv.slice(2);
if (!resourcesArg || !installArg || !evidenceArg) throw new Error('Resources, installation and evidence paths required');
const resources = resolve(resourcesArg);
const installRoot = resolve(installArg);
const child = relative(resolve(process.env.RUNNER_TEMP), installRoot);
if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Installation must be inside runner temporary storage');
const payload = join(resources, 'payload/metawork');
const { desktopProcessEnvironment, desktopToolPaths } = await import('../apps/desktop/dist/platform-tools.mjs');
const environment = desktopProcessEnvironment({ releaseRoot: payload, nodePath: desktopToolPaths(payload).node, env: process.env });
for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];
Object.assign(process.env, environment, { METAWORK_INSTALL_ROOT: installRoot, ANYFUSION_INSTALL_ROOT: installRoot,
  METAWORK_CONFIG_HOME: join(installRoot, 'config-home'), ANYFUSION_CONFIG_HOME: join(installRoot, 'config-home'),
  METAWORK_DESKTOP_INTERNAL: '1', METAWORK_INTERNAL_LLM_SOURCE_ROOT: join(installRoot, 'absent-developer-config') });
const descriptor = JSON.parse(await readFile(join(resources, 'desktop-release.json'), 'utf8'));
const { runDesktopInstall } = await import(pathToFileURL(join(payload, 'dist/desktop-install-cli.js')));
async function* input() {
  yield JSON.stringify({ baseUrl: 'https://provider.example.invalid/v1', modelId: 'deepseek-chat', apiKey: 'isolated-install-fixture' });
}
await runDesktopInstall(['install', resources, installRoot, descriptor.desktopVersion], input());
const current = await realpath(join(installRoot, 'app/current'));
assert.equal(current, await realpath(join(installRoot, 'app/releases', descriptor.releaseId)));
const require = createRequire(pathToFileURL(join(current, 'package.json')));
const native = require(join(current, 'native/windows/metawork-platform.node'));
const credentials = JSON.parse(native.readPrivateFile(installRoot, 'credentials.json').toString());
assert.equal(credentials.providers.provider, 'isolated-install-fixture');
const Database = require('better-sqlite3');
const database = new Database(join(installRoot, 'accounts/local-default/data/anyfusion.db'), { readonly: true, fileMustExist: true });
try { assert.deepEqual(database.pragma('integrity_check'), [{ integrity_check: 'ok' }]); }
finally { database.close(); }
await writeFile(evidenceArg, JSON.stringify({ passed: true, scope: 'formal-isolated-windows-installation',
  sourceCommit: descriptor.sourceCommit, releaseId: descriptor.releaseId,
  privateCredentials: true, installedNativeModule: true, databaseIntegrity: true,
  serverVerified: false, desktopVerified: false, realModelTaskVerified: false }, null, 2));
console.log('Formal isolated Windows installation passed; Server and Desktop acceptance remain open.');
