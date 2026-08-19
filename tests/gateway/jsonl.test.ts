import { describe, expect, it } from 'vitest';
import {
  MAX_JSON_LINE_BYTES,
  createJsonLineParser,
  encodeJsonLine,
} from '../../src/gateway/jsonl.js';
import { resolveGatewaySocketPath } from '../../src/gateway/gateway-paths.js';

describe('gateway jsonl protocol', () => {
  it('encodes messages as newline-delimited JSON', () => {
    expect(encodeJsonLine({ type: 'input', text: 'hello' })).toBe('{"type":"input","text":"hello"}\n');
  });

  it('parses messages across arbitrary chunks', () => {
    const messages: unknown[] = [];
    const parse = createJsonLineParser(message => messages.push(message));

    parse('{"type":"input"');
    parse(',"text":"hello"}\n{"type":"close"}\n');

    expect(messages).toEqual([
      { type: 'input', text: 'hello' },
      { type: 'close' },
    ]);
  });

  it('reports malformed JSON without throwing from the socket callback', () => {
    const messages: unknown[] = [];
    const errors: Error[] = [];
    const parse = createJsonLineParser(
      message => messages.push(message),
      { onError: error => errors.push(error) },
    );

    expect(() => parse('{"type":}\n')).not.toThrow();
    parse('{"type":"close"}\n');

    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('invalid JSON line');
  });

  it('rejects an unterminated frame before its buffer can grow without bound', () => {
    const errors: Error[] = [];
    const parse = createJsonLineParser(
      () => undefined,
      {
        maxFrameBytes: 16,
        onError: error => errors.push(error),
      },
    );

    parse('x'.repeat(17));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('exceeds 16 bytes');
    expect(MAX_JSON_LINE_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it('resolves the gateway socket inside the Metaclaw home directory', () => {
    expect(resolveGatewaySocketPath('/tmp/metaclaw-home')).toBe('/tmp/metaclaw-home/gateway.sock');
  });
});
