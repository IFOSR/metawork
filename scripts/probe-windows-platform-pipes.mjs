import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function until(operation) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = operation();
    if (result !== null && result !== false) return result;
    await delay(2);
  }
  throw new Error('Native pipe operation timed out');
}

export async function probePlatformPipes(addon, output) {
  const name = `\\\\.\\pipe\\metawork-platform-${randomUUID()}`;
  const checks = [];
  const handles = new Set();
  let listener;
  const close = (handle) => { addon.pipeClose(handle); handles.delete(handle); };
  const pair = async () => {
    const client = await until(() => addon.pipeConnect(name, process.pid)); handles.add(client);
    const server = await until(() => addon.pipeAccept(listener)); handles.add(server);
    assert.equal(addon.pipePeerPid(client), process.pid);
    assert.equal(addon.pipePeerPid(server), process.pid);
    return { client, server };
  };
  const write = async (handle, bytes) => {
    if (!addon.pipeWrite(handle, bytes)) await until(() => addon.pipeWriteReady(handle));
  };
  const read = (handle) => until(() => addon.pipeRead(handle));
  try {
    for (const invalid of ['\\\\remote\\pipe\\metawork-test', name + '\\nested', name + '\0suffix']) {
      assert.throws(() => addon.pipeListen(invalid));
    }
    listener = addon.pipeListen(name);
    assert.throws(() => addon.pipeListen(name));
    assert.throws(() => addon.pipeRead(listener));
    assert.throws(() => addon.pipeAccept({}));
    checks.push('owned handle tags, local path boundary and first-instance reservation');
    for (let index = 0; index < 24; index++) {
      const { client, server } = await pair();
      const bytes = Buffer.from(`中文 reconnect ${index}\n`);
      await write(client, bytes); assert.deepEqual(await read(server), bytes);
      await write(server, bytes); assert.deepEqual(await read(client), bytes);
      close(client); assert.equal((await read(server)).length, 0); close(server);
      assert.throws(() => addon.pipeListen(name));
    }
    checks.push('24 sequential clients, bidirectional bytes and EOF without losing listener ownership');
    const pairs = [];
    for (let index = 0; index < 12; index++) pairs.push(await pair());
    await Promise.all(pairs.map(async ({ client, server }, index) => {
      const bytes = Buffer.alloc(4096, index);
      await write(client, bytes); assert.deepEqual(await read(server), bytes);
      await write(server, bytes); assert.deepEqual(await read(client), bytes);
    }));
    for (const { client, server } of pairs) { close(client); close(server); }
    checks.push('12 simultaneous clients on one persistent pipe name');
    // CreateFile can connect, but a claimed JSON PID cannot replace OS identity.
    assert.throws(() => addon.pipeConnect(name, process.pid + 1), /PID/);
    try { const rejected = addon.pipeAccept(listener); if (rejected) addon.pipeClose(rejected); }
    catch (error) { assert.match(error.message, /client PID|OpenProcess peer/); }
    const { client, server } = await pair();
    let writes = 0;
    while (writes++ < 1024 && addon.pipeWrite(client, Buffer.alloc(65536, 42))) { /* fill kernel buffer */ }
    assert(writes <= 1024, 'non-reading peer must apply backpressure');
    assert.throws(() => addon.pipeWrite(client, Buffer.from('overlap')), /pending/);
    let received = 0;
    while (received < writes * 65536) {
      const bytes = await read(server); assert(bytes.length > 0);
      assert(bytes.every(byte => byte === 42)); received += bytes.length;
    }
    await until(() => addon.pipeWriteReady(client));
    assert.equal(addon.pipeRead(server), null); // pending read is cancelled on close
    close(server); close(client);
    const cancelled = await pair();
    while (addon.pipeWrite(cancelled.client, Buffer.alloc(65536))) { /* leave a pending write */ }
    close(cancelled.client); close(cancelled.server);
    checks.push('bounded writes, backpressure, pending read/write cancellation and peer-PID refusal');
    addon.pipeCloseListener(listener); addon.pipeCloseListener(listener);
    assert.throws(() => addon.pipeAccept(listener), /open listener/);
    listener = addon.pipeListen(name);
    await writeFile(output, JSON.stringify({ passed: true, host: process.versions, checks,
      scope: 'production-pipe-primitives', gatewayIntegrated: false }, null, 2));
  } finally {
    for (const handle of handles) addon.pipeClose(handle);
    if (listener) addon.pipeCloseListener(listener);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'win32') throw new Error('Native Windows required');
  const require = createRequire(import.meta.url);
  const addon = resolve('native/windows/build/Release/metawork_platform.node');
  const evidence = resolve('.tmp/windows-desktop-validation/platform-pipes');
  await mkdir(evidence, { recursive: true });
  await probePlatformPipes(require(addon), join(evidence, 'node.json'));
  const electronResult = join(evidence, 'electron.json');
  const entry = join(evidence, 'electron.cjs');
  await writeFile(entry, `const {app}=require('electron');
    app.setPath('userData', ${JSON.stringify(join(evidence, 'electron-home'))});
    app.whenReady().then(async()=>{
      const {probePlatformPipes}=await import(${JSON.stringify(import.meta.url)});
      await probePlatformPipes(require(${JSON.stringify(addon)}), ${JSON.stringify(electronResult)});
      app.quit();
    }).catch(error=>{console.error(error);app.exit(1)});`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
  execFileSync(require(resolve('apps/desktop/node_modules/electron')), [entry], { env, stdio: 'inherit', timeout: 60000 });
  assert.equal(JSON.parse(await readFile(electronResult, 'utf8')).passed, true);
}
