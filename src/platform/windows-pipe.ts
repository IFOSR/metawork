import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { Duplex } from 'node:stream';

/** Opaque handles are also type-tagged and validated by the native module. */
type PipeHandle = object;
export interface WindowsPipePrimitives {
  pipeListen(name: string): PipeHandle;
  pipeAccept(listener: PipeHandle): PipeHandle | null;
  pipeConnect(name: string, expectedPid: number): PipeHandle | null;
  pipePeerPid(pipe: PipeHandle): number;
  pipeRead(pipe: PipeHandle): Buffer | null;
  pipeWrite(pipe: PipeHandle, bytes: Buffer): boolean;
  pipeWriteReady(pipe: PipeHandle): boolean;
  pipeClose(pipe: PipeHandle): void;
  pipeCloseListener(listener: PipeHandle): void;
}

export function loadWindowsPipes(modulePath: string): WindowsPipePrimitives {
  if (process.platform !== 'win32' || !isAbsolute(modulePath)) throw new Error('Absolute Windows platform module required');
  const addon: unknown = createRequire(import.meta.url)(modulePath);
  if (!addon || typeof addon !== 'object' || !['pipeListen', 'pipeAccept', 'pipeConnect', 'pipePeerPid',
    'pipeRead', 'pipeWrite', 'pipeWriteReady', 'pipeClose', 'pipeCloseListener']
    .every(name => typeof (addon as Record<string, unknown>)[name] === 'function')) {
    throw new Error('Incompatible Windows pipe adapter');
  }
  return addon as WindowsPipePrimitives;
}

function failure(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

/** A bounded Duplex over public Win32 overlapped I/O. No private net.Socket APIs. */
export class WindowsPipeStream extends Duplex {
  readonly peerPid: number;
  private timer?: NodeJS.Timeout;
  private reading = false;
  private outgoing?: { bytes: Buffer; offset: number; pending: boolean; callback(error?: Error | null): void };

  constructor(private readonly native: WindowsPipePrimitives, private readonly handle: PipeHandle) {
    super({ allowHalfOpen: false, readableHighWaterMark: 65536, writableHighWaterMark: 65536 });
    this.peerPid = native.pipePeerPid(handle);
  }

  override _read(): void { this.reading = true; this.schedule(); }

  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outgoing = { bytes, offset: 0, pending: false, callback };
    this.schedule();
  }

  override _final(callback: (error?: Error | null) => void): void {
    // Named pipes have no directional shutdown. At this point all queued bytes
    // completed; close both directions, matching this transport's no-half-open contract.
    this.reading = false;
    try { this.native.pipeClose(this.handle); this.push(null); callback(); }
    catch (error) { callback(failure(error)); }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let result = error;
    try { this.native.pipeClose(this.handle); } catch (closeError) { result ??= failure(closeError); }
    const outgoing = this.outgoing;
    this.outgoing = undefined;
    outgoing?.callback(result ?? new Error('Windows pipe closed before write completed'));
    callback(result);
  }

  private schedule(): void {
    if (this.destroyed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 2);
  }

  private pump(): void {
    if (this.destroyed) return;
    try {
      const outgoing = this.outgoing;
      if (outgoing && (!outgoing.pending || this.native.pipeWriteReady(this.handle))) {
        outgoing.pending = false;
        // Bound work per event-loop turn as well as per native write.
        for (let budget = 0; budget < 8 && outgoing.offset < outgoing.bytes.length; budget++) {
          const part = outgoing.bytes.subarray(outgoing.offset, outgoing.offset + 65536);
          outgoing.offset += part.length;
          if (!this.native.pipeWrite(this.handle, part)) { outgoing.pending = true; break; }
        }
        if (!outgoing.pending && outgoing.offset === outgoing.bytes.length) {
          this.outgoing = undefined; outgoing.callback();
        }
      }
      for (let budget = 0; this.reading && !this.destroyed && budget < 8; budget++) {
        const bytes = this.native.pipeRead(this.handle);
        if (bytes === null) break;
        if (bytes.length === 0) { this.reading = false; this.push(null); break; }
        if (!this.push(bytes)) this.reading = false;
      }
    } catch (error) { this.destroy(failure(error)); return; }
    if (this.reading || this.outgoing) this.schedule();
  }
}

export async function connectWindowsPipe(
  native: WindowsPipePrimitives, name: string, expectedPid: number, signal?: AbortSignal,
): Promise<WindowsPipeStream> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const handle = native.pipeConnect(name, expectedPid);
    if (handle) return new WindowsPipeStream(native, handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Windows pipe connection timed out');
}

export class WindowsPipeServer extends EventEmitter {
  private listener?: PipeHandle;
  private timer?: NodeJS.Timeout;
  private readonly connections = new Set<WindowsPipeStream>();
  private closing = false;
  constructor(private readonly native: WindowsPipePrimitives) { super(); }

  listen(name: string, callback?: () => void): this {
    if (this.listener || this.closing) throw new Error('Windows pipe server already started');
    this.listener = this.native.pipeListen(name);
    if (callback) this.once('listening', callback);
    queueMicrotask(() => { if (this.listener) { this.emit('listening'); this.poll(); } });
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    if (!this.listener || this.closing) {
      queueMicrotask(() => callback?.(new Error('Windows pipe server is not listening')));
      return this;
    }
    this.closing = true;
    if (callback) this.once('close', callback);
    if (this.timer) clearTimeout(this.timer);
    this.native.pipeCloseListener(this.listener);
    this.listener = undefined;
    this.finishClose();
    return this;
  }

  private finishClose(): void {
    if (this.closing && !this.connections.size) {
      this.closing = false;
      queueMicrotask(() => this.emit('close'));
    }
  }

  private poll(): void {
    if (!this.listener) return;
    try {
      // Leave kernel backpressure in place when the bounded client set is full.
      for (let budget = 0; budget < 16 && this.connections.size < 128; budget++) {
        const handle = this.native.pipeAccept(this.listener);
        if (!handle) break;
        const stream = new WindowsPipeStream(this.native, handle);
        this.connections.add(stream);
        stream.once('close', () => { this.connections.delete(stream); this.finishClose(); });
        this.emit('connection', stream);
        if (!this.listener) return;
      }
    } catch (error) { this.emit('error', failure(error)); }
    if (this.listener) this.timer = setTimeout(() => this.poll(), 2);
  }
}
