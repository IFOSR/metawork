import { createHash } from 'node:crypto';
import type { GatewayEventEnvelope } from './client-events.js';

export interface CompletedGatewayResult {
  resultId: string;
  content: string;
  certification: 'certified' | 'uncertified';
  completeness: 'complete' | 'partial' | 'incomplete';
}

interface ResultAssembly {
  contentHash: string;
  byteLength: number;
  certification: CompletedGatewayResult['certification'];
  completeness: CompletedGatewayResult['completeness'];
  chunks: Map<number, string>;
}

export class ResultStreamAssembler {
  private readonly assemblies = new Map<string, ResultAssembly>();
  private readonly completed = new Map<string, CompletedGatewayResult>();

  consume(event: GatewayEventEnvelope): CompletedGatewayResult | null {
    const payload = asRecord(event.payload);
    const resultId = stringValue(payload.resultId);
    if (!resultId) return null;
    if (event.kind === 'result_delivery_available') {
      const metadata = parseMetadata(payload);
      if (!metadata) return null;
      this.assemblies.set(resultId, { ...metadata, chunks: new Map() });
      return null;
    }
    if (event.kind === 'result_chunk') {
      const assembly = this.assemblies.get(resultId);
      const offset = nonNegativeInteger(payload.offset);
      const chunk = stringValue(payload.chunk);
      if (!assembly || offset === null || chunk === null) return null;
      const existing = assembly.chunks.get(offset);
      if (existing !== undefined && existing !== chunk) {
        throw new Error(`Gateway result chunk conflicts at offset ${offset}: ${resultId}`);
      }
      assembly.chunks.set(offset, chunk);
      return null;
    }
    if (event.kind !== 'result_completed') return null;
    const existing = this.completed.get(resultId);
    if (existing) return existing;
    const assembly = this.assemblies.get(resultId);
    const metadata = parseMetadata(payload);
    if (!assembly || !metadata) return null;
    if (
      assembly.contentHash !== metadata.contentHash
      || assembly.byteLength !== metadata.byteLength
      || assembly.certification !== metadata.certification
      || assembly.completeness !== metadata.completeness
    ) {
      throw new Error(`Gateway result metadata changed before completion: ${resultId}`);
    }
    const content = assembleChunks(resultId, assembly);
    const bytes = Buffer.from(content, 'utf8');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (
      bytes.byteLength !== assembly.byteLength
      || contentHash !== assembly.contentHash
    ) {
      throw new Error(`Gateway result verification failed: ${resultId}`);
    }
    const completed: CompletedGatewayResult = {
      resultId,
      content,
      certification: assembly.certification,
      completeness: assembly.completeness,
    };
    this.completed.set(resultId, completed);
    return completed;
  }

  find(resultId: string): CompletedGatewayResult | null {
    return this.completed.get(resultId) ?? null;
  }

  clear(): void {
    this.assemblies.clear();
    this.completed.clear();
  }
}

function assembleChunks(resultId: string, assembly: ResultAssembly): string {
  const ordered = [...assembly.chunks.entries()]
    .sort(([left], [right]) => left - right);
  let expectedOffset = 0;
  const chunks: string[] = [];
  for (const [offset, chunk] of ordered) {
    if (offset !== expectedOffset) {
      throw new Error(`Gateway result chunk gap at offset ${expectedOffset}: ${resultId}`);
    }
    chunks.push(chunk);
    expectedOffset += Buffer.byteLength(chunk, 'utf8');
  }
  return chunks.join('');
}

function parseMetadata(
  payload: Record<string, unknown>,
): Omit<ResultAssembly, 'chunks'> | null {
  const contentHash = stringValue(payload.contentHash);
  const byteLength = nonNegativeInteger(payload.byteLength);
  const certification = payload.certification;
  const completeness = payload.completeness;
  if (
    !contentHash
    || byteLength === null
    || !['certified', 'uncertified'].includes(String(certification))
    || !['complete', 'partial', 'incomplete'].includes(String(completeness))
  ) {
    return null;
  }
  return {
    contentHash,
    byteLength,
    certification: certification as ResultAssembly['certification'],
    completeness: completeness as ResultAssembly['completeness'],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
