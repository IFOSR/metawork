import { isIP } from 'node:net';
import { hasImageSignature, type ImageInput } from './image-input-loader.js';
import { buildImageRequest } from './image-request-builder.js';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 32 * 1024 * 1024;

export interface ImageApiClientInput {
  operation: 'generation' | 'editing';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  inputs: readonly ImageInput[];
  signal?: AbortSignal;
}

export interface ImageApiOutput {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export async function requestImage(input: ImageApiClientInput): Promise<ImageApiOutput[]> {
  const request = await buildImageRequest(input);
  const response = await fetch(request.url, request.init);
  const body = (await readResponseBytes(response, MAX_PROVIDER_RESPONSE_BYTES)).toString('utf8');
  if (!response.ok) {
    throw new Error(`image provider error (${response.status}): ${body.slice(0, 2_000)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('image provider returned invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error('image provider returned no image data');
  }
  const outputs: ImageApiOutput[] = [];
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { b64_json?: unknown; url?: unknown };
    if (typeof record.b64_json === 'string') {
      outputs.push(decodeImage(record.b64_json));
      continue;
    }
    if (typeof record.url === 'string') {
      outputs.push(await downloadImage(record.url, input.signal));
    }
  }
  if (outputs.length === 0) throw new Error('image provider returned no image data');
  return outputs;
}

async function readResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) {
    throw new Error(`image provider response exceeds ${limit} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`image provider response exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function decodeImage(value: string): ImageApiOutput {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error('image provider returned invalid image base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
    throw new Error('image provider image exceeds the output size limit');
  }
  const mimeType = detectMimeType(bytes);
  if (!mimeType || !hasImageSignature(bytes, mimeType)) {
    throw new Error('image provider returned an invalid image signature');
  }
  return { bytes, mimeType };
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<ImageApiOutput> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('image provider returned an unsupported image URL');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('image provider returned a private image URL');
  }
  const response = await fetch(parsed, { redirect: 'error', signal });
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_OUTPUT_IMAGE_BYTES) {
    throw new Error('downloaded image exceeds the output size limit');
  }
  const declaredType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (declaredType && declaredType !== 'application/octet-stream' && !declaredType.startsWith('image/')) {
    throw new Error('downloaded image has an unsupported MIME type');
  }
  const bytes = await readResponseBytes(response, MAX_OUTPUT_IMAGE_BYTES);
  if (!response.ok || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
    throw new Error(`image download failed (${response.status})`);
  }
  const mimeType = detectMimeType(bytes);
  if (!mimeType || !hasImageSignature(bytes, mimeType)) {
    throw new Error('downloaded image has an invalid signature');
  }
  return { bytes, mimeType };
}

function detectMimeType(bytes: Uint8Array): ImageApiOutput['mimeType'] | null {
  if (hasImageSignature(bytes, 'image/png')) return 'image/png';
  if (hasImageSignature(bytes, 'image/jpeg')) return 'image/jpeg';
  if (hasImageSignature(bytes, 'image/webp')) return 'image/webp';
  if (hasImageSignature(bytes, 'image/gif')) return 'image/gif';
  return null;
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isIP(normalized) === 6) {
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[01])\./u.test(normalized);
  }
  return normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || normalized.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(normalized)
    || normalized.endsWith('.local');
}
