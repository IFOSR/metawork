import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResultStreamAssembler } from '../../src/gateway/result-stream-assembler.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

describe('ResultStreamAssembler', () => {
  it('reassembles UTF-8 chunks by byte offset and ignores replay duplicates', () => {
    const assembler = new ResultStreamAssembler();
    const content = '第一段\nsecond';
    const first = '第一段\n';
    const contentHash = hash(content);

    assembler.consume(event('available', 'result_delivery_available', {
      resultId: 'result_1',
      contentHash,
      byteLength: Buffer.byteLength(content),
      completeness: 'complete',
      certification: 'certified',
    }));
    assembler.consume(event('chunk_2', 'result_chunk', {
      resultId: 'result_1',
      offset: Buffer.byteLength(first),
      chunk: 'second',
      byteLength: Buffer.byteLength('second'),
    }));
    assembler.consume(event('chunk_1', 'result_chunk', {
      resultId: 'result_1',
      offset: 0,
      chunk: first,
      byteLength: Buffer.byteLength(first),
    }));
    assembler.consume(event('chunk_1_replay', 'result_chunk', {
      resultId: 'result_1',
      offset: 0,
      chunk: first,
      byteLength: Buffer.byteLength(first),
    }));

    expect(assembler.consume(event('completed', 'result_completed', {
      resultId: 'result_1',
      contentHash,
      byteLength: Buffer.byteLength(content),
      completeness: 'complete',
      certification: 'certified',
    }))).toEqual({
      resultId: 'result_1',
      content,
      certification: 'certified',
      completeness: 'complete',
    });
  });

  it('rejects a completed result whose hash does not match', () => {
    const assembler = new ResultStreamAssembler();
    assembler.consume(event('available', 'result_delivery_available', {
      resultId: 'result_1',
      contentHash: hash('expected'),
      byteLength: Buffer.byteLength('expected'),
      completeness: 'complete',
      certification: 'certified',
    }));
    assembler.consume(event('chunk', 'result_chunk', {
      resultId: 'result_1',
      offset: 0,
      chunk: 'tampered',
      byteLength: Buffer.byteLength('tampered'),
    }));

    expect(() => assembler.consume(event('completed', 'result_completed', {
      resultId: 'result_1',
      contentHash: hash('expected'),
      byteLength: Buffer.byteLength('expected'),
      completeness: 'complete',
      certification: 'certified',
    }))).toThrow('verification failed');
  });
});

function event(
  eventId: string,
  kind: GatewayEventEnvelope['kind'],
  payload: unknown,
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId,
    sequence: 1,
    accountId: 'local-default',
    conversationId: 'conv_1',
    requestId: 'req_1',
    turnId: 'turn_1',
    kind,
    payload,
    occurredAt: '2026-08-21T00:00:00.000Z',
  };
}

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
}
