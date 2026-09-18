import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../gateway/attachment-store-port.js';
import {
  AttachmentInputError,
  AttachmentTypeError,
} from '../gateway/attachment-store-port.js';

export {
  AttachmentInputError,
  AttachmentTypeError,
  MAX_ATTACHMENT_BYTES,
} from '../gateway/attachment-store-port.js';

/**
 * Conversation-scoped opaque attachment storage.
 *
 * 目录布局：`<root>/<conversationId>/<attachmentId>__<safeName>`。
 * Runtime owns identity/hash validation but never parses attachment contents.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_NAME_PATTERN = /^[^/\\<>:"|?*\x00-\x1f]{1,180}$/u;
const SIGNATURE_BYTES = 12;

export type AttachmentMediaClass =
  | 'image'
  | 'text'
  | 'document'
  | 'archive'
  | 'binary'
  | 'unknown';

export interface AttachmentMetadata {
  readonly attachmentId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly mime: string;
  readonly mediaClass: AttachmentMediaClass;
  /** @deprecated Use mediaClass. Retained while Gateway clients migrate. */
  readonly kind: 'image' | 'text' | 'file';
  readonly size: number;
  readonly sha256: string;
  readonly status: 'available' | 'unavailable';
  readonly createdAt: string;
}

export interface SaveAttachmentInput {
  readonly conversationId?: string;
  /** @deprecated Use conversationId. */
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly name: string;
  readonly bytes: Buffer;
}

export interface SaveAttachmentStreamInput {
  readonly conversationId?: string;
  /** @deprecated Use conversationId. */
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly name: string;
  readonly source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

interface SniffResult {
  readonly mediaClass: AttachmentMediaClass;
  readonly mime: string;
}

export interface FileAttachmentStoreOptions {
  readonly accountId: string;
  readonly maxAttachmentBytes?: number;
}

const IMAGE_SIGNATURES: Array<{ mime: string; test: (bytes: Buffer) => boolean }> = [
  { mime: 'image/png', test: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/gif', test: bytes => bytes.subarray(0, 4).toString('ascii') === 'GIF8' },
  {
    mime: 'image/webp',
    test: bytes => bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

const TEXT_EXTENSIONS: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.sh': 'text/x-shellscript',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.sql': 'text/x-sql',
};

const DOCUMENT_EXTENSIONS: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ARCHIVE_EXTENSIONS: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.zip': 'application/zip',
};

export class FileAttachmentStore {
  readonly rootDir: string;
  readonly accountId: string;
  readonly maxAttachmentBytes: number;

  constructor(rootDir: string, options: FileAttachmentStoreOptions = { accountId: 'local-default' }) {
    this.rootDir = resolve(rootDir);
    this.accountId = options.accountId;
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
    if (!IDENTIFIER_PATTERN.test(this.accountId)) {
      throw new AttachmentInputError(`Invalid account ID: ${this.accountId}`);
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  async saveAttachment(input: SaveAttachmentInput): Promise<AttachmentMetadata> {
    return this.saveAttachmentStream({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      name: input.name,
      source: [input.bytes],
    });
  }

  async saveAttachmentStream(input: SaveAttachmentStreamInput): Promise<AttachmentMetadata> {
    const conversationId = input.conversationId ?? input.sessionId ?? '';
    if (!IDENTIFIER_PATTERN.test(conversationId)) {
      throw new AttachmentInputError(`Invalid conversation ID: ${conversationId}`);
    }
    const workspaceId = input.workspaceId ?? 'workspace-unknown';
    if (!IDENTIFIER_PATTERN.test(workspaceId)) {
      throw new AttachmentInputError(`Invalid workspace ID: ${workspaceId}`);
    }
    if (!input.name || !SAFE_NAME_PATTERN.test(input.name)) {
      throw new AttachmentInputError(`Invalid attachment name: ${JSON.stringify(input.name)}`);
    }

    const attachmentId = `att_${randomBytes(10).toString('base64url')}`;
    const directory = this.conversationDirectory(conversationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const extension = normalizedExtension(input.name);
    const safeName = sanitizeFileName(input.name);
    const suffix = safeName.toLowerCase().endsWith(extension) ? '' : extension;
    const targetPath = join(directory, `${attachmentId}__${safeName}${suffix}`);
    const metadataPath = `${targetPath}.meta.json`;
    const temporaryPath = join(directory, `.${attachmentId}.uploading`);
    const temporaryMetadataPath = `${temporaryPath}.meta.json`;
    const hash = createHash('sha256');
    const signatureChunks: Buffer[] = [];
    let signatureSize = 0;
    let size = 0;
    let dataPublished = false;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      try {
        for await (const value of input.source) {
          const chunk = Buffer.from(value);
          if (chunk.byteLength === 0) continue;
          size += chunk.byteLength;
          if (size > this.maxAttachmentBytes) {
            throw new AttachmentInputError(
              `Attachment "${input.name}" exceeds ${this.maxAttachmentBytes} bytes`,
            );
          }
          hash.update(chunk);
          if (signatureSize < SIGNATURE_BYTES) {
            const prefix = chunk.subarray(0, SIGNATURE_BYTES - signatureSize);
            signatureChunks.push(prefix);
            signatureSize += prefix.byteLength;
          }
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await handle.write(chunk.subarray(written));
            if (result.bytesWritten === 0) {
              throw new Error('Attachment storage made no progress while writing upload data');
            }
            written += result.bytesWritten;
          }
        }
      } finally {
        await handle.close();
      }

      const sniffed = this.sniff(
        input.name,
        Buffer.concat(signatureChunks, signatureSize),
      );
      const metadata: AttachmentMetadata = {
        attachmentId,
        accountId: this.accountId,
        conversationId,
        workspaceId,
        name: input.name,
        mime: sniffed.mime,
        mediaClass: sniffed.mediaClass,
        kind: sniffed.mediaClass === 'image'
          ? 'image'
          : sniffed.mediaClass === 'text' ? 'text' : 'file',
        size,
        sha256: hash.digest('hex'),
        status: 'available',
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        temporaryMetadataPath,
        `${JSON.stringify(metadata, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await rename(temporaryPath, targetPath);
      dataPublished = true;
      await rename(temporaryMetadataPath, metadataPath);
      return metadata;
    } catch (error) {
      await Promise.all([
        rm(temporaryPath, { force: true }),
        rm(temporaryMetadataPath, { force: true }),
        ...(dataPublished ? [rm(targetPath, { force: true })] : []),
      ]);
      throw error;
    }
  }

  async readAttachment(conversationId: string, attachmentId: string): Promise<{
    metadata: AttachmentMetadata;
    bytes: Buffer;
    path: string;
  } | null> {
    const located = await this.locateAttachment(conversationId, attachmentId);
    if (!located) return null;
    const { readFile } = await import('node:fs/promises');
    const metadata = JSON.parse(await readFile(located.metadataPath, 'utf8')) as AttachmentMetadata;
    const bytes = await readFile(located.dataPath);
    return { metadata, bytes, path: located.dataPath };
  }

  readAttachmentSync(conversationId: string, attachmentId: string): {
    metadata: AttachmentMetadata;
    bytes: Buffer;
    path: string;
  } | null {
    const located = this.locateAttachmentSync(conversationId, attachmentId);
    if (!located) return null;
    const metadata = JSON.parse(readFileSync(located.metadataPath, 'utf8')) as AttachmentMetadata;
    return {
      metadata,
      bytes: readFileSync(located.dataPath),
      path: located.dataPath,
    };
  }

  async readAttachmentMetadata(
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentMetadata | null> {
    const located = await this.locateAttachment(conversationId, attachmentId);
    if (!located) return null;
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(located.metadataPath, 'utf8')) as AttachmentMetadata;
  }

  private async locateAttachment(
    conversationId: string,
    attachmentId: string,
  ): Promise<{ dataPath: string; metadataPath: string } | null> {
    if (!IDENTIFIER_PATTERN.test(conversationId)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }
    if (!IDENTIFIER_PATTERN.test(attachmentId)) {
      throw new Error(`Invalid attachment ID: ${attachmentId}`);
    }
    const directory = this.conversationDirectory(conversationId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return null;
    }
    const dataName = names.find(name => name.startsWith(`${attachmentId}__`)
      && !name.endsWith('.meta.json'));
    if (!dataName) return null;
    const metaName = names.find(name => name === `${dataName}.meta.json`);
    if (!metaName) return null;
    return {
      dataPath: join(directory, dataName),
      metadataPath: join(directory, metaName),
    };
  }

  private locateAttachmentSync(
    conversationId: string,
    attachmentId: string,
  ): { dataPath: string; metadataPath: string } | null {
    if (!IDENTIFIER_PATTERN.test(conversationId)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }
    if (!IDENTIFIER_PATTERN.test(attachmentId)) {
      throw new Error(`Invalid attachment ID: ${attachmentId}`);
    }
    const directory = this.conversationDirectory(conversationId);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return null;
    }
    const dataName = names.find(name => name.startsWith(`${attachmentId}__`)
      && !name.endsWith('.meta.json'));
    if (!dataName) return null;
    const metaName = names.find(name => name === `${dataName}.meta.json`);
    if (!metaName) return null;
    return {
      dataPath: join(directory, dataName),
      metadataPath: join(directory, metaName),
    };
  }

  async listAttachments(conversationId: string): Promise<AttachmentMetadata[]> {
    if (!IDENTIFIER_PATTERN.test(conversationId)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }
    let names: string[];
    try {
      names = await readdir(this.conversationDirectory(conversationId));
    } catch {
      return [];
    }
    const { readFile } = await import('node:fs/promises');
    const metadata: AttachmentMetadata[] = [];
    for (const name of names.filter(candidate => candidate.endsWith('.meta.json'))) {
      try {
        metadata.push(JSON.parse(
          await readFile(join(this.conversationDirectory(conversationId), name), 'utf8'),
        ) as AttachmentMetadata);
      } catch {
        // 损坏的元数据直接忽略。
      }
    }
    return metadata.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deleteSessionAttachments(conversationId: string): Promise<number> {
    if (!IDENTIFIER_PATTERN.test(conversationId)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }
    const directory = this.conversationDirectory(conversationId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return 0;
    }
    const quarantine = join(this.rootDir, 'quarantine');
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    const destination = join(quarantine, `${conversationId}.${Date.now()}`);
    try {
      await rename(directory, destination);
    } catch {
      return 0;
    }
    return names.filter(name => !name.endsWith('.meta.json')).length;
  }

  private conversationDirectory(conversationId: string): string {
    const path = resolve(this.rootDir, conversationId);
    if (!path.startsWith(`${this.rootDir}/`)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }
    return path;
  }

  private sniff(name: string, bytes: Buffer): SniffResult {
    for (const signature of IMAGE_SIGNATURES) {
      if (signature.test(bytes)) {
        return { mediaClass: 'image', mime: signature.mime };
      }
    }

    const extension = normalizedExtension(name);
    if (extension in TEXT_EXTENSIONS) {
      return { mediaClass: 'text', mime: TEXT_EXTENSIONS[extension]! };
    }
    if (extension in DOCUMENT_EXTENSIONS) {
      return { mediaClass: 'document', mime: DOCUMENT_EXTENSIONS[extension]! };
    }
    if (extension in ARCHIVE_EXTENSIONS) {
      return { mediaClass: 'archive', mime: ARCHIVE_EXTENSIONS[extension]! };
    }
    return { mediaClass: 'unknown', mime: 'application/octet-stream' };
  }
}

function normalizedExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index).toLowerCase();
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80);
}
