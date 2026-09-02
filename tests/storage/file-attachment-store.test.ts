import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileAttachmentStore,
  AttachmentTypeError,
} from '../../src/storage/file-attachment-store.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pngBytes(size = 64): Buffer {
  const body = Buffer.alloc(Math.max(0, size - PNG_MAGIC.length), 7);
  return Buffer.concat([PNG_MAGIC, body]).subarray(0, size);
}

const temporaryRoots: string[] = [];

async function createStore(): Promise<{ store: FileAttachmentStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-attachments-'));
  temporaryRoots.push(root);
  const store = new FileAttachmentStore(join(root, 'attachments'));
  await store.initialize();
  return { store, root };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('FileAttachmentStore', () => {
  it('saves a png image with sniffed mime and image kind', async () => {
    const { store, root } = await createStore();
    const meta = await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'chart.png',
      bytes: pngBytes(),
    });

    expect(meta.kind).toBe('image');
    expect(meta.mime).toBe('image/png');
    expect(meta.name).toBe('chart.png');
    expect(meta.size).toBe(64);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(meta.attachmentId).toMatch(/^att_[A-Za-z0-9_-]+$/u);

    const stored = await readFile(
      join(root, 'attachments', 'sess_web_abc', `${meta.attachmentId}__chart.png`),
    );
    expect(stored.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
  });

  it('sniffs jpeg regardless of misleading extension', async () => {
    const { store } = await createStore();
    const meta = await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'photo.txt',
      bytes: Buffer.concat([JPEG_MAGIC, Buffer.alloc(32, 1)]),
    });

    expect(meta.kind).toBe('image');
    expect(meta.mime).toBe('image/jpeg');
  });

  it('stores text files under the text kind', async () => {
    const { store } = await createStore();
    const meta = await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'notes.md',
      bytes: Buffer.from('# hello\n内容', 'utf8'),
    });

    expect(meta.kind).toBe('text');
    expect(meta.mime).toBe('text/markdown');
  });

  it('rejects disallowed binary types', async () => {
    const { store } = await createStore();

    await expect(store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'evil.exe',
      bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    })).rejects.toBeInstanceOf(AttachmentTypeError);
  });

  it('stores images and text files larger than the retired fixed limits', async () => {
    const { store } = await createStore();
    const legacyImageLimit = 10 * 1024 * 1024;
    const legacyTextLimit = 5 * 1024 * 1024;

    const image = await store.saveAttachment({
      sessionId: 's',
      name: 'big.png',
      bytes: pngBytes(legacyImageLimit + 1),
    });

    const text = await store.saveAttachment({
      sessionId: 's',
      name: 'big.md',
      bytes: Buffer.alloc(legacyTextLimit + 1, 97),
    });

    expect(image.size).toBe(legacyImageLimit + 1);
    expect(text.size).toBe(legacyTextLimit + 1);
  });

  it('removes temporary files when a streaming upload fails', async () => {
    const { store, root } = await createStore();
    async function* failingSource(): AsyncGenerator<Buffer> {
      yield PNG_MAGIC;
      throw new Error('client disconnected');
    }

    await expect(store.saveAttachmentStream({
      sessionId: 's',
      name: 'interrupted.png',
      source: failingSource(),
    })).rejects.toThrow('client disconnected');

    expect(await readdir(join(root, 'attachments', 's'))).toEqual([]);
  });

  it('rejects path traversal in session id or file name', async () => {
    const { store } = await createStore();

    await expect(store.saveAttachment({
      sessionId: '../escape',
      name: 'a.md',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid session ID/u);

    await expect(store.saveAttachment({
      sessionId: 's',
      name: '../../escape.md',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid attachment name/u);

    await expect(store.saveAttachment({
      sessionId: 's',
      name: '',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid attachment name/u);
  });

  it('lists attachments of a session', async () => {
    const { store } = await createStore();
    await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'a.md',
      bytes: Buffer.from('a'),
    });
    await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'b.png',
      bytes: pngBytes(),
    });
    await store.saveAttachment({
      sessionId: 'sess_other',
      name: 'c.md',
      bytes: Buffer.from('c'),
    });

    const list = await store.listAttachments('sess_web_abc');
    expect(list.map(entry => entry.name).sort()).toEqual(['a.md', 'b.png']);
    expect(await store.listAttachments('sess_none')).toEqual([]);
  });

  it('deletes all attachments of a session', async () => {
    const { store, root } = await createStore();
    await store.saveAttachment({
      sessionId: 'sess_web_abc',
      name: 'a.md',
      bytes: Buffer.from('a'),
    });
    await store.deleteSessionAttachments('sess_web_abc');

    expect(await store.listAttachments('sess_web_abc')).toEqual([]);
    expect(await readdir(join(root, 'attachments')).catch(() => ['sess_other'])).not.toContain(
      'sess_web_abc',
    );
  });
});
