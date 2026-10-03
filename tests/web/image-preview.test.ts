import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageDimensions, loadImagePreview } from '../../web/src/image-preview.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('image decode budgets', () => {
  it('reads dimensions before decoding and refuses unknown or animated formats', () => {
    expect(imageDimensions(png)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 0])]);
    expect(imageDimensions(animated)).toBeNull();
  });
  it('caps concurrent downloads, checks pixels before creating an object URL, and releases allocations', async () => {
    vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png)));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const signal = new AbortController().signal;
    const images = await Promise.all(Array.from({ length: 4 }, () => loadImagePreview('/image.png', signal)));
    try { await expect(loadImagePreview('/fifth.png', signal)).rejects.toThrow('count_limit'); }
    finally { images.forEach(image => image.release()); }
    expect(revoke).toHaveBeenCalledTimes(4);
    const oversized = Buffer.from(png); oversized.writeUInt32BE(100000, 16); oversized.writeUInt32BE(100000, 20);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(oversized)));
    await expect(loadImagePreview('/large.png', signal)).rejects.toThrow('pixel_limit');
    expect(create).toHaveBeenCalledTimes(4);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png)));
    const next = await loadImagePreview('/again.png', signal); next.release(); next.release();
    expect(revoke).toHaveBeenCalledTimes(5);
  });
});
