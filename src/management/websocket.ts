import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_FRAME_OVERHEAD_BYTES = 14;

export interface WebSocketConnectionOptions {
  onMessage: (text: string) => void;
  onClose: () => void;
  onError?: (error: Error) => void;
}

/**
 * 最小化 RFC 6455 服务端连接：文本帧、close、ping/pong。
 * 本地单用户场景足够；不支持分片与二进制（浏览器发送的小文本消息不会分片）。
 */
export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private finalized = false;

  constructor(
    private readonly socket: Socket,
    private readonly options: WebSocketConnectionOptions,
  ) {
    socket.on('data', chunk => this.handleData(chunk as Buffer));
    socket.on('close', () => {
      this.closed = true;
      this.finalize();
    });
    socket.on('error', error => {
      this.options.onError?.(error as Error);
    });
  }

  static accept(socket: Socket, key: string): void {
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + '\r\n',
    );
  }

  send(text: string): void {
    if (this.closed || this.socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    let frame: Buffer;
    if (payload.length < 126) {
      frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    } else if (payload.length < 65536) {
      const header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
      frame = Buffer.concat([header, payload]);
    } else {
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      frame = Buffer.concat([header, payload]);
    }
    this.socket.write(frame);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      // close 帧（opcode 0x8）
      if (!this.socket.destroyed) {
        this.socket.write(Buffer.from([0x88, 0x00]));
        this.socket.end();
      }
    }
    this.finalize();
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > MAX_MESSAGE_BYTES + MAX_FRAME_OVERHEAD_BYTES) {
      this.close();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  private parseFrames(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const extendedLength = this.buffer.readBigUInt64BE(2);
        if (extendedLength > BigInt(MAX_MESSAGE_BYTES)) {
          this.close();
          return;
        }
        payloadLength = Number(extendedLength);
        offset = 10;
      }
      if (payloadLength > MAX_MESSAGE_BYTES) {
        this.close();
        return;
      }

      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLength) return;

      let payload = this.buffer.subarray(offset, offset + payloadLength);
      if (masked && maskKey) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ maskKey![index % 4]));
      }

      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode === 0xa) {
        continue; // pong，忽略
      }
      if (opcode === 0x1) {
        this.options.onMessage(payload.toString('utf8'));
        continue;
      }
      // 忽略其他 opcode（binary / continuation / reserved）
    }
  }

  private sendPong(payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const header = Buffer.from([0x8a, payload.length]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.options.onClose();
  }
}
