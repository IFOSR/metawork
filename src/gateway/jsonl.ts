export const MAX_JSON_LINE_BYTES = 256 * 1024;

export interface JsonLineParserOptions {
  readonly maxFrameBytes?: number;
  readonly onError?: (error: Error) => void;
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function createJsonLineParser<T>(
  onMessage: (message: T) => void,
  options: JsonLineParserOptions = {},
): (chunk: Buffer | string) => void {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_JSON_LINE_BYTES;
  let buffer = Buffer.alloc(0);
  let failed = false;

  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    buffer = Buffer.alloc(0);
    options.onError?.(error);
  };

  return (chunk) => {
    if (failed) return;
    buffer = Buffer.concat([
      buffer,
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    ]);
    while (true) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        if (buffer.byteLength > maxFrameBytes) {
          fail(new Error(`JSON line exceeds ${maxFrameBytes} bytes`));
        }
        break;
      }
      const frame = buffer.subarray(0, newlineIndex);
      buffer = buffer.subarray(newlineIndex + 1);
      if (frame.byteLength > maxFrameBytes) {
        fail(new Error(`JSON line exceeds ${maxFrameBytes} bytes`));
        break;
      }
      const line = frame.toString('utf8').trim();
      if (!line) {
        continue;
      }
      let message: T;
      try {
        message = JSON.parse(line) as T;
      } catch {
        fail(new Error('invalid JSON line'));
        break;
      }
      onMessage(message);
    }
  };
}
