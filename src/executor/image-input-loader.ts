import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export interface ImageInput {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  bytes: Buffer;
}

export interface ImageInputLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_IMAGE_INPUT_LIMITS: ImageInputLimits = {
  maxFiles: 4,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
};

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
} as const;

export async function loadInputImages(
  inputsPath: string | undefined,
  limits: ImageInputLimits = DEFAULT_IMAGE_INPUT_LIMITS,
): Promise<ImageInput[]> {
  if (!inputsPath) return [];
  const root = resolve(inputsPath);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const imageEntries = entries
    .filter(entry => entry.isFile() && Object.hasOwn(IMAGE_TYPES, extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (imageEntries.length > limits.maxFiles) {
    throw new Error(`too many input images: maximum is ${limits.maxFiles}`);
  }

  const images: ImageInput[] = [];
  let totalBytes = 0;
  for (const entry of imageEntries) {
    const filePath = resolve(root, entry.name);
    if (!filePath.startsWith(`${root}${sep}`)) {
      throw new Error(`input image path escapes inputs directory: ${entry.name}`);
    }
    const info = await stat(filePath);
    if (!info.isFile()) continue;
    if (info.size > limits.maxFileBytes) {
      throw new Error(`input image exceeds ${limits.maxFileBytes} bytes: ${entry.name}`);
    }
    totalBytes += info.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`input images exceed ${limits.maxTotalBytes} total bytes`);
    }
    const bytes = await readFile(filePath);
    const mimeType = IMAGE_TYPES[extname(entry.name).toLowerCase() as keyof typeof IMAGE_TYPES];
    if (!hasImageSignature(bytes, mimeType)) {
      throw new Error(`input image has an invalid signature: ${entry.name}`);
    }
    images.push({ name: entry.name, mimeType, bytes });
  }
  return images;
}

export function hasImageSignature(
  bytes: Uint8Array,
  mimeType: ImageInput['mimeType'],
): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8
      && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
}

export function mimeTypeExtension(mimeType: string): '.png' | '.jpg' | '.webp' | '.gif' {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.png';
  }
}
