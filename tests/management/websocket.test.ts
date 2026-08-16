import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketConnection } from '../../src/management/websocket.js';

const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: Buffer[] = [];

  write(chunk: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

describe('WebSocketConnection lifecycle', () => {
  it('finalizes exactly once when closed by the server', () => {
    const socket = new FakeSocket();
    const onClose = vi.fn();
    const connection = new WebSocketConnection(socket as never, {
      onMessage: vi.fn(),
      onClose,
    });

    connection.close();
    connection.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes immediately when a declared message exceeds the size limit', () => {
    const socket = new FakeSocket();
    const onClose = vi.fn();
    new WebSocketConnection(socket as never, {
      onMessage: vi.fn(),
      onClose,
    });
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(MAX_WEBSOCKET_MESSAGE_BYTES + 1), 2);

    socket.emit('data', header);

    expect(socket.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
