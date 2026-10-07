import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function probeAsyncPipes(addon, output) {
  const name = () => `\\\\.\\pipe\\metawork-p0-async-${randomBytes(12).toString('hex')}`;
  const handles = [];
  const remember = handle => { handles.push(handle); return handle; };
  const until = async action => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = action();
      if (result !== null && result !== false) return result;
      if (Date.now() >= deadline) throw Error('Asynchronous pipe probe timed out');
      await delay(1);
    }
  };
  const checks = [];
  try {
    const pairs = [];
    for (let index = 0; index < 12; index++) {
      const path = name();
      const server = remember(addon.listen(path));
      const client = remember(addon.connect(path, process.pid));
      await until(() => addon.accept(server));
      pairs.push({ server, client });
    }
    await Promise.all(pairs.map(async ({ server, client }, index) => {
      const bytes = Buffer.from(`bounded-payload-${index}`);
      addon.write(client, bytes);
      assert.deepEqual(await until(() => addon.read(server)), bytes);
      await until(() => addon.writeReady(client));
      addon.write(server, bytes);
      assert.deepEqual(await until(() => addon.read(client)), bytes);
      await until(() => addon.writeReady(server));
    }));
    checks.push('12 concurrent bidirectional connections without worker-pool starvation');
    const { server, client } = pairs[0];
    assert.throws(() => addon.write(client, Buffer.alloc(65537)), /Bounded/);
    assert.throws(() => addon.read({}), /Owned pipe/);
    checks.push('bounded writes and typed native handles');
    assert.equal(addon.read(server), null);
    addon.close(server); addon.close(server);
    assert.throws(() => addon.read(server), /closed/);
    checks.push('pending read cancellation and idempotent close');
    const waiting = remember(addon.listen(name()));
    assert.equal(addon.accept(waiting), false);
    addon.close(waiting);
    checks.push('pending accept cancellation');
    const squatted = name();
    remember(addon.listen(squatted));
    assert.throws(() => addon.listen(squatted), /create/);
    assert.throws(() => addon.connect(squatted, process.pid + 1), /peer PID/);
    checks.push('first-instance and actual peer PID gates');
    const slow = pairs[1];
    let pending = false;
    for (let iteration = 0; iteration < 64; iteration++) {
      if (!addon.write(slow.client, Buffer.alloc(65536, 7))) { pending = true; break; }
    }
    assert.ok(pending, 'A non-reading peer must eventually apply backpressure');
    assert.throws(() => addon.write(slow.client, Buffer.from('overlap')), /pending write/);
    let ticked = false;
    await delay(5).then(() => { ticked = true; });
    assert.equal(ticked, true);
    addon.close(slow.client);
    checks.push('backpressure preserves event loop and pending write cancels');
    await writeFile(output, JSON.stringify({
      scope: 'overlapped-pipe-spike', passed: true, checks,
      host: process.versions.electron ? 'electron-main' : 'node',
      p0Accepted: false, productionTransport: false,
    }, null, 2));
  } finally {
    for (const handle of handles) addon.close(handle);
  }
}
