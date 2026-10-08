import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { WindowsNativeStream } from './windows-native-stream.js';

function failure(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

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

/** Only this authenticated transport class is admitted by the local Gateway. */
export class WindowsPipeStream extends WindowsNativeStream {
  readonly peerPid: number;
  constructor(native: WindowsPipePrimitives, handle: PipeHandle) {
    super(native, handle);
    this.peerPid = native.pipePeerPid(handle);
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
