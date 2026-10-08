// Bundled into a disposable fixture for real cross-account Gateway checks.
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { discoverDesktopSession } from '../src/client/desktop-session-client.js';
import type { ClientGateway } from '../src/gateway/client-gateway.js';
import { FileEventJournal } from '../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../src/gateway/gateway-subscriptions.js';
import { MetaclawGatewayServer } from '../src/gateway/server.js';
import { DesktopSessionService } from '../src/management/desktop-session.js';
import { PlannerHostBridge } from '../src/tui-bridge/planner-host-bridge.js';
import { loadWindowsPrivateFiles } from '../src/platform/windows-private-files.js';

const [mode, name, expected] = process.argv.slice(2);
const root = resolve('private');
const modulePath = resolve('metawork_platform.node');
// libuv reports Windows access denial as EPERM for named-pipe connect and
// EACCES for ordinary file reads. Neither missing endpoints nor timeouts pass.
const accessDenied = (error: NodeJS.ErrnoException) => error.code === 'EACCES' || error.code === 'EPERM';
if (mode === 'serve') {
  const files = loadWindowsPrivateFiles(modulePath);
  files.ensurePrivateDirectory(root);
  const service = new DesktopSessionService(() => ({
    installationId: createHash('sha256').update(canonical).digest('hex'),
    instanceId: 'native-security', accountId: 'local-default', releaseId: 'security-fixture',
    pid: process.pid, webOrigin: 'http://127.0.0.1:8788', gatewayProtocolVersion: 2,
  }));
  const canonical = await realpath(root);
  const server = new MetaclawGatewayServer({ socketPath: name, windowsPipeModulePath: modulePath,
    gateway: { handle: async () => { throw new Error('No commands in security fixture'); } } as unknown as ClientGateway,
    journal: new FileEventJournal(join(root, 'journal')), subscriptions: new GatewaySubscriptions(),
    authorizeAttach: async () => false, registerDesktopSession: (nonce, account) => service.issue(nonce, account) });
  await server.start();
  const planner = new PlannerHostBridge({ socketPath: `${name}-planner`, windowsPipeModulePath: modulePath });
  await planner.start();
  const close = async () => { await Promise.all([server.stop(), planner.stop()]); };
  files.writePrivateFile(root, 'endpoint.json', Buffer.from(JSON.stringify({
    manifestVersion: 1, releaseId: 'security-fixture', serverVersion: 'fixture', gatewayProtocolVersion: 2,
    pid: process.pid, startedAt: new Date().toISOString(), state: 'ready', unixSocketPath: name,
    webOrigin: 'http://127.0.0.1:8788',
  })));
  await writeFile('ready', String(process.pid));
  const deadline = setTimeout(() => { void close(); }, 60000);
  const stop = setInterval(() => {
    void readFile('stop').then(async () => {
      clearInterval(stop); clearTimeout(deadline); await close();
    }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }, 50);
  deadline.unref(); stop.unref();
} else if (mode === 'client') {
  const grant = await discoverDesktopSession({ installRoot: root, manifestPath: join(root, 'endpoint.json'),
    releaseId: 'security-fixture', windowsModulePath: modulePath });
  if (grant.pid !== Number(expected)) throw new Error('Wrong Gateway PID');
  await new Promise<void>((done, reject) => {
    const client = createConnection(`${name}-planner`);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('Planner response timed out')); }, 5000);
    client.once('connect', () => client.write(JSON.stringify({ protocolVersion: 2, type: 'ping', requestId: 'probe' }) + '\n'));
    let body = '';
    client.on('data', bytes => {
      body += bytes.toString();
      if (!body.includes('\n')) return;
      clearTimeout(timer); client.destroy();
      const response = JSON.parse(body.trim());
      if (response.error?.code === 'hello_required') done(); else reject(new Error('Unexpected Planner response'));
    });
    client.once('error', error => { clearTimeout(timer); reject(error); });
  });
  console.log(JSON.stringify({ passed: true, scope: 'native-gateway-owner-session', plannerHostVerified: true }));
} else if (mode === 'denied') {
  // Use an ordinary net client so denial must come from Windows, not our client checks.
  for (const endpoint of [name, `${name}-planner`]) await new Promise<void>((done, reject) => {
    const client = createConnection(endpoint);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('Access denial timed out')); }, 5000);
    client.once('connect', () => {
      clearTimeout(timer); client.destroy(); reject(new Error('Other account connected to private Gateway'));
    });
    client.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); client.destroy();
      if (!accessDenied(error)) reject(error); else done();
    });
  });
  // The same account must also be unable to read the private endpoint directly.
  let denied = false;
  try { await readFile(join(root, 'endpoint.json')); }
  catch (error) { denied = accessDenied(error as NodeJS.ErrnoException); }
  if (!denied) throw new Error('Other account read the private endpoint');
  console.log(JSON.stringify({ passed: true, scope: 'native-gateway-cross-account-denial', plannerHostVerified: true }));
} else if (mode === 'remote-denied') {
  // The OS must deny the SMB path even for the owning identity.
  for (const endpoint of [name, `${name}-planner`]) await new Promise<void>((done, reject) => {
    const client = createConnection(endpoint);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('Remote denial timed out')); }, 5000);
    client.once('connect', () => { clearTimeout(timer); client.destroy(); reject(new Error('Remote Gateway connected')); });
    client.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); client.destroy();
      if (!accessDenied(error)) reject(error); else done();
    });
  });
  console.log(JSON.stringify({ passed: true, scope: 'native-gateway-SMB-denial', plannerHostVerified: true }));
} else throw new Error(`Unknown security fixture mode: ${mode}`);
