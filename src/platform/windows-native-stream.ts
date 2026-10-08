import { Duplex } from 'node:stream';

/** Byte transport shared by owned stdio and local pipes; carries no identity authority. */
export interface WindowsStreamPrimitives {
  pipeRead(pipe: object): Buffer | null;
  pipeWrite(pipe: object, bytes: Buffer): boolean;
  pipeWriteReady(pipe: object): boolean;
  pipeClose(pipe: object): void;
}

function failure(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

/** A bounded Duplex over public Win32 overlapped I/O. No private net.Socket APIs. */
export class WindowsNativeStream extends Duplex {
  private timer?: NodeJS.Timeout;
  private reading = false;
  private outgoing?: { bytes: Buffer; offset: number; pending: boolean; callback(error?: Error | null): void };

  constructor(private readonly native: WindowsStreamPrimitives, private readonly handle: object) {
    super({ allowHalfOpen: false, readableHighWaterMark: 65536, writableHighWaterMark: 65536 });
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

