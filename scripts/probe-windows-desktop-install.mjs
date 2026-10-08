// Formal installer against a verified candidate, isolated from every user install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows runner required');
const [resourcesArg, installArg, evidenceArg, clientArg] = process.argv.slice(2);
if (!resourcesArg || !installArg || !evidenceArg || !clientArg) throw new Error('Resources, installation, evidence and client paths required');
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
const { DesktopServiceManager, exchangeDesktopSession } = await import(pathToFileURL(resolve(clientArg)));
const manager = new DesktopServiceManager({ installRoot, releaseId: descriptor.releaseId,
  nodePath: desktopToolPaths(current).node, configHome: join(installRoot, 'config-home'), env: process.env });
let connected = false;
try {
  const grant = await manager.connect();
  connected = true;
  assert.equal((await manager.connect()).pid, grant.pid);
  let cookie = '';
  const sessionFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(url, { ...options, headers });
    const values = response.headers.getSetCookie();
    if (values.length) cookie = values.map(value => value.split(';')[0]).join('; ');
    return response;
  };
  assert.equal((await (await fetch(`${grant.webOrigin}/api/auth/session`)).json()).authenticated, false);
  await exchangeDesktopSession(grant, sessionFetch);
  assert.equal((await (await sessionFetch(`${grant.webOrigin}/api/auth/session`)).json()).authenticated, true);
  const web = await sessionFetch(grant.webOrigin);
  assert.equal(web.status, 200);
  assert.match(await web.text(), /id="root"/u);
  await manager.stop();
  connected = false;
  assert.throws(() => process.kill(grant.pid, 0), error => error.code === 'ESRCH');
  for (const path of ['server-endpoint.json', 'data/runtime.lock']) {
    await assert.rejects(readFile(join(installRoot, path)), error => error.code === 'ENOENT');
  }
  assert.equal(JSON.parse(native.readPrivateFile(installRoot, 'server-stop-receipt.json').toString()).stopped, true);
  const installed = JSON.parse(await readFile(evidenceArg, 'utf8'));
  await writeFile(evidenceArg, JSON.stringify({ ...installed, serverVerified: true, desktopSessionVerified: true,
    formalDrainVerified: true, ordinaryBrowserRequiresLogin: true, actualGuiVerified: false }, null, 2));
  console.log('Installed Windows Server start, Desktop session, browser login boundary and formal drain passed; GUI/task acceptance remains open.');
} catch (error) {
  const log = await readFile(join(installRoot, 'logs/desktop-server.log'), 'utf8').catch(() => '');
  // Keep only bounded failure lines; never upload manual login tokens or keys.
  const diagnosis = log.slice(-32_768).split(/\r?\n/u)
    .filter(line => /error|failed|^\s+at /iu.test(line) && !/token|credential|secret|api.?key/iu.test(line))
    .map(line => line.replace(/[a-f0-9]{32,}/giu, '[redacted-identity]')).slice(-50).join('\n');
  await writeFile(`${evidenceArg}.server-error.txt`, diagnosis);
  throw error;
} finally {
  if (connected) await manager.stop();
}
