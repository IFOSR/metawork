const MAX_ENCODED_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const TOTAL_PIXELS = 8_000_000;
let reservedPixels = 0;
let reservedImages = 0;

/** Inspect raster headers before asking the browser to allocate decoded pixels. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a
    && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    // Animated PNG can retain many frames; use the original-file link instead.
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      if (view.getUint32(offset + 4) === 0x6163544c) return null;
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) return null;
      offset += length + 12;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const kind = view.getUint32(12);
    if (kind === 0x56503858 && !(bytes[20]! & 2)) return {
      width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    };
    if (kind === 0x5650384c && bytes[20] === 0x2f) {
      const size = view.getUint32(21, true);
      return { width: (size & 0x3fff) + 1, height: ((size >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
  }
  if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) return null;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
      }
      offset += length;
    }
  }
  // Other formats retain their original-file link; unknown dimensions never
  // bypass the decode budget (including SVG and animated formats).
  return null;
}

export async function loadImagePreview(source: string, signal: AbortSignal): Promise<{ url: string; release(): void }> {
  if (reservedImages >= 4) throw new Error('image_preview_count_limit');
  reservedImages++;
  try {
    const response = await fetch(source, { signal, credentials: new URL(source, location.href).origin === location.origin ? 'same-origin' : 'omit' });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_ENCODED_BYTES || !response.body) throw new Error('image_preview_unavailable');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > MAX_ENCODED_BYTES) throw new Error('image_preview_byte_limit');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const dimensions = imageDimensions(bytes);
    const pixels = dimensions ? dimensions.width * dimensions.height : 0;
    if (signal.aborted || !pixels || pixels > MAX_PIXELS || reservedPixels + pixels > TOTAL_PIXELS) {
      throw new Error('image_preview_pixel_limit');
    }
    const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0x52 ? 'image/webp' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    reservedPixels += pixels;
    let released = false;
    return { url, release() {
      if (released) return; released = true; URL.revokeObjectURL(url); reservedPixels -= pixels; reservedImages--;
    } };
  } catch (error) { reservedImages--; throw error; }
}
