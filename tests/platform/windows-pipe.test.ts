import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWindowsPipe, loadWindowsPipes, WindowsPipeServer, type WindowsPipePrimitives,
  type WindowsPipeStream } from '../../src/platform/windows-pipe.js';

// Uses the production .node binary, built by the native Windows validation job.
describe.skipIf(process.platform !== 'win32')('native Windows pipe streams', () => {
  let native: WindowsPipePrimitives;
  let server: WindowsPipeServer;
  let name: string;
  let errors: Error[];
  let streams: WindowsPipeStream[];
  beforeEach(async () => {
    native = loadWindowsPipes(resolve('native/windows/build/Release/metawork_platform.node'));
    name = `\\\\.\\pipe\\metawork-stream-${randomUUID()}`;
    errors = []; streams = [];
    server = new WindowsPipeServer(native);
    server.on('error', (error: Error) => errors.push(error));
    server.on('connection', (stream: WindowsPipeStream) => {
      streams.push(stream); stream.on('error', (error: Error) => errors.push(error));
    });
    const listening = once(server, 'listening');
    server.listen(name); await listening;
  });
  afterEach(async () => {
    for (const stream of streams) stream.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  async function client(): Promise<WindowsPipeStream> {
    const stream = await connectWindowsPipe(native, name, process.pid);
    streams.push(stream); stream.on('error', (error: Error) => errors.push(error));
    return stream;
  }

  it('delivers final responses across sequential and simultaneous clients', async () => {
    server.on('connection', (stream: WindowsPipeStream) => {
      expect(stream.peerPid).toBe(process.pid);
      stream.once('data', (bytes: Buffer) => stream.end(bytes));
    });
    const exchange = async (index: number) => {
      const stream = await client();
      expect(stream.peerPid).toBe(process.pid);
      const response: Buffer[] = [];
      stream.on('data', (bytes: Buffer) => response.push(bytes));
      const ended = once(stream, 'end');
      stream.write(`中文 request ${index}`);
      await ended;
      expect(Buffer.concat(response).toString()).toBe(`中文 request ${index}`);
      stream.destroy();
    };
    for (let index = 0; index < 8; index++) await exchange(index);
    await Promise.all(Array.from({ length: 12 }, (_, index) => exchange(index)));
    expect(errors).toEqual([]);
  }, 15000);

  it('honors Duplex backpressure while keeping the event loop responsive', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 42);
    let received = 0;
    let ticks = 0;
    let invalid = false;
    const tick = setInterval(() => ticks++, 1);
    server.on('connection', (stream: WindowsPipeStream) => {
      // Hold the read side to force the client's overlapped write to remain pending.
      setTimeout(() => {
        stream.on('data', (bytes: Buffer) => {
          received += bytes.length;
          invalid ||= bytes.some(byte => byte !== 42);
          if (received === payload.length) stream.end('complete');
        });
      }, 100);
    });
    try {
      const stream = await client();
      const response: Buffer[] = [];
      stream.on('data', (bytes: Buffer) => response.push(bytes));
      const ended = once(stream, 'end');
      expect(stream.write(payload)).toBe(false);
      await ended;
      expect(Buffer.concat(response).toString()).toBe('complete');
      expect(received).toBe(payload.length);
      expect(invalid).toBe(false);
      expect(ticks).toBeGreaterThan(10);
      expect(errors).toEqual([]);
    } finally { clearInterval(tick); }
  }, 15000);

  it('cancels a pending read and releases the name after all streams close', async () => {
    const accepted = once(server, 'connection');
    const stream = await client();
    const [peer] = await accepted as [WindowsPipeStream];
    stream.resume(); peer.resume();
    const closed = once(server, 'close');
    server.close();
    const clientClosed = once(stream, 'close');
    const peerClosed = once(peer, 'close');
    stream.destroy(); peer.destroy();
    await Promise.all([closed, clientClosed, peerClosed]);
    const next = native.pipeListen(name);
    native.pipeCloseListener(next);
    expect(errors).toEqual([]);
  });
});
