import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadInputImages,
  type ImageInputLimits,
} from '../../src/executor/image-input-loader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('loadInputImages', () => {
  it('loads supported images in stable order and rejects invalid signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-image-inputs-'));
    roots.push(root);
    await writeFile(join(root, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(join(root, 'a.png'), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    await writeFile(join(root, 'notes.txt'), 'ignore');

    await expect(loadInputImages(root)).resolves.toEqual([
      expect.objectContaining({ name: 'a.png', mimeType: 'image/png' }),
      expect.objectContaining({ name: 'b.jpg', mimeType: 'image/jpeg' }),
    ]);
  });

  it('keeps historical artifacts before current task resources in the materialized order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-image-input-order-'));
    roots.push(root);
    await writeFile(join(root, 'input-01-generated.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    await writeFile(join(root, 'input-02-reference.png'), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    await writeFile(join(root, 'input-03-upload.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x02]));

    await expect(loadInputImages(root)).resolves.toEqual([
      expect.objectContaining({ name: 'input-01-generated.jpg' }),
      expect.objectContaining({ name: 'input-02-reference.png' }),
      expect.objectContaining({ name: 'input-03-upload.jpg' }),
    ]);
  });

  it('fails when the image count or byte limits are exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-image-input-limits-'));
    roots.push(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'one.png'), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));

    const limits: ImageInputLimits = {
      maxFiles: 0,
      maxFileBytes: 1024,
      maxTotalBytes: 1024,
    };
    await expect(loadInputImages(root, limits)).rejects.toThrow(/too many input images/i);
  });
});
