import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileAttachmentStore,
  MAX_ATTACHMENT_BYTES,
} from '../../src/storage/file-attachment-store.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pngBytes(size = 64): Buffer {
  const body = Buffer.alloc(Math.max(0, size - PNG_MAGIC.length), 7);
  return Buffer.concat([PNG_MAGIC, body]).subarray(0, size);
}

const temporaryRoots: string[] = [];

async function createStore(options: { maxAttachmentBytes?: number } = {}): Promise<{
  store: FileAttachmentStore;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-attachments-'));
  temporaryRoots.push(root);
  const store = new FileAttachmentStore(join(root, 'attachments'), {
    accountId: 'local-default',
    ...(options.maxAttachmentBytes !== undefined
      ? { maxAttachmentBytes: options.maxAttachmentBytes }
      : {}),
  });
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
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'chart.png',
      bytes: pngBytes(),
    });

    expect(meta.mediaClass).toBe('image');
    expect(meta.mime).toBe('image/png');
    expect(meta.accountId).toBe('local-default');
    expect(meta.conversationId).toBe('sess_web_abc');
    expect(meta.workspaceId).toBe('workspace_alpha');
    expect(meta.status).toBe('available');
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
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'photo.txt',
      bytes: Buffer.concat([JPEG_MAGIC, Buffer.alloc(32, 1)]),
    });

    expect(meta.mediaClass).toBe('image');
    expect(meta.mime).toBe('image/jpeg');
  });

  it('stores text files under the text kind', async () => {
    const { store } = await createStore();
    const meta = await store.saveAttachment({
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'notes.md',
      bytes: Buffer.from('# hello\n内容', 'utf8'),
    });

    expect(meta.mediaClass).toBe('text');
    expect(meta.mime).toBe('text/markdown');
  });

  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['report.pdf', 'application/pdf'],
    ['report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['report.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('stores supported document input %s without parsing it', async (name, mime) => {
    const { store } = await createStore();
    const bytes = name.endsWith('.pdf')
      ? Buffer.from('%PDF-1.7\nopaque-document', 'utf8')
      : Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

    const meta = await store.saveAttachment({
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name,
      bytes,
    });

    expect(meta).toMatchObject({
      mediaClass: 'document',
      mime,
      size: bytes.length,
    });
    expect(await store.readAttachmentMetadata('sess_web_abc', meta.attachmentId))
      .toEqual(meta);
  });

  it('stores unknown binary input as an opaque resource', async () => {
    const { store } = await createStore();

    const meta = await store.saveAttachment({
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'sample.bin',
      bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    });

    expect(meta.mediaClass).toBe('unknown');
    expect(meta.mime).toBe('application/octet-stream');
  });

  it('bounds the single-file upload contract at 100 MiB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
  });

  it('rejects a streaming upload above the bounded file limit and removes temporary data', async () => {
    const limit = 4096;
    const { store } = await createStore({ maxAttachmentBytes: limit });

    await expect(store.saveAttachmentStream({
      conversationId: 's',
      workspaceId: 'workspace_alpha',
      name: 'too-large.bin',
      source: [Buffer.alloc(limit), Buffer.from([1])],
    })).rejects.toThrow(/exceeds/u);
    expect(await store.listAttachments('s')).toEqual([]);
  });

  it('removes temporary files when a streaming upload fails', async () => {
    const { store, root } = await createStore();
    async function* failingSource(): AsyncGenerator<Buffer> {
      yield PNG_MAGIC;
      throw new Error('client disconnected');
    }

    await expect(store.saveAttachmentStream({
      conversationId: 's',
      workspaceId: 'workspace_alpha',
      name: 'interrupted.png',
      source: failingSource(),
    })).rejects.toThrow('client disconnected');

    expect(await readdir(join(root, 'attachments', 's'))).toEqual([]);
  });

  it('rejects path traversal in session id or file name', async () => {
    const { store } = await createStore();

    await expect(store.saveAttachment({
      conversationId: '../escape',
      workspaceId: 'workspace_alpha',
      name: 'a.md',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid conversation ID/u);

    await expect(store.saveAttachment({
      conversationId: 's',
      workspaceId: 'workspace_alpha',
      name: '../../escape.md',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid attachment name/u);

    await expect(store.saveAttachment({
      conversationId: 's',
      workspaceId: 'workspace_alpha',
      name: '',
      bytes: Buffer.from('x'),
    })).rejects.toThrow(/Invalid attachment name/u);
  });

  it('lists attachments of a session', async () => {
    const { store } = await createStore();
    await store.saveAttachment({
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'a.md',
      bytes: Buffer.from('a'),
    });
    await store.saveAttachment({
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
      name: 'b.png',
      bytes: pngBytes(),
    });
    await store.saveAttachment({
      conversationId: 'sess_other',
      workspaceId: 'workspace_beta',
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
      conversationId: 'sess_web_abc',
      workspaceId: 'workspace_alpha',
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
