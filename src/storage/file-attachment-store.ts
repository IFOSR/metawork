import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Web 会话附件存储（图片 + 文本类）。
 *
 * 目录布局：`<root>/<sessionId>/<attachmentId>__<safeName>`，
 * 元数据写入同名 `.meta.json` 旁车文件，供上传端点与 Planner 链路读取。
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_NAME_PATTERN = /^[^/\\<>:"|?*\x00-\x1f]{1,180}$/u;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export type AttachmentKind = 'image' | 'text';

export interface AttachmentMetadata {
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mime: string;
  readonly kind: AttachmentKind;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface SaveAttachmentInput {
  readonly sessionId: string;
  readonly name: string;
  readonly bytes: Buffer;
}

export class AttachmentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTypeError';
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTooLargeError';
  }
}

interface SniffResult {
  readonly kind: AttachmentKind;
  readonly mime: string;
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

export class FileAttachmentStore {
  static readonly MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
  static readonly MAX_TEXT_BYTES = MAX_TEXT_BYTES;

  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  async saveAttachment(input: SaveAttachmentInput): Promise<AttachmentMetadata> {
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      throw new Error(`Invalid session ID: ${input.sessionId}`);
    }
    if (!input.name || !SAFE_NAME_PATTERN.test(input.name)) {
      throw new Error(`Invalid attachment name: ${JSON.stringify(input.name)}`);
    }

    const sniffed = this.sniffOrThrow(input.name, input.bytes);
    const attachmentId = `att_${randomBytes(10).toString('base64url')}`;
    const directory = this.sessionDirectory(input.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const metadata: AttachmentMetadata = {
      attachmentId,
      sessionId: input.sessionId,
      name: input.name,
      mime: sniffed.mime,
      kind: sniffed.kind,
      size: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      createdAt: new Date().toISOString(),
    };

    const extension = normalizedExtension(input.name);
    const safeName = sanitizeFileName(input.name);
    const suffix = safeName.toLowerCase().endsWith(extension) ? '' : extension;
    const targetPath = join(directory, `${attachmentId}__${safeName}${suffix}`);
    await writeFile(targetPath, input.bytes, { mode: 0o600 });
    await writeFile(
      `${targetPath}.meta.json`,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return metadata;
  }

  async readAttachment(sessionId: string, attachmentId: string): Promise<{
    metadata: AttachmentMetadata;
    bytes: Buffer;
    path: string;
  } | null> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    const directory = this.sessionDirectory(sessionId);
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

    const { readFile } = await import('node:fs/promises');
    const metadata = JSON.parse(await readFile(join(directory, metaName), 'utf8')) as AttachmentMetadata;
    const bytes = await readFile(join(directory, dataName));
    return { metadata, bytes, path: join(directory, dataName) };
  }

  async listAttachments(sessionId: string): Promise<AttachmentMetadata[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    let names: string[];
    try {
      names = await readdir(this.sessionDirectory(sessionId));
    } catch {
      return [];
    }
    const { readFile } = await import('node:fs/promises');
    const metadata: AttachmentMetadata[] = [];
    for (const name of names.filter(candidate => candidate.endsWith('.meta.json'))) {
      try {
        metadata.push(JSON.parse(await readFile(join(this.sessionDirectory(sessionId), name), 'utf8')) as AttachmentMetadata);
      } catch {
        // 损坏的元数据直接忽略。
      }
    }
    return metadata.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deleteSessionAttachments(sessionId: string): Promise<number> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    const directory = this.sessionDirectory(sessionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return 0;
    }
    const quarantine = join(this.rootDir, 'quarantine');
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    const destination = join(quarantine, `${sessionId}.${Date.now()}`);
    try {
      await rename(directory, destination);
    } catch {
      return 0;
    }
    return names.filter(name => !name.endsWith('.meta.json')).length;
  }

  private sessionDirectory(sessionId: string): string {
    const path = resolve(this.rootDir, sessionId);
    if (!path.startsWith(`${this.rootDir}/`)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return path;
  }

  private sniffOrThrow(name: string, bytes: Buffer): SniffResult {
    for (const signature of IMAGE_SIGNATURES) {
      if (signature.test(bytes)) {
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new AttachmentTooLargeError(
            `Image exceeds ${MAX_IMAGE_BYTES} bytes limit`,
          );
        }
        return { kind: 'image', mime: signature.mime };
      }
    }

    const extension = normalizedExtension(name);
    if (extension in TEXT_EXTENSIONS) {
      if (bytes.byteLength > MAX_TEXT_BYTES) {
        throw new AttachmentTooLargeError(
          `Text file exceeds ${MAX_TEXT_BYTES} bytes limit`,
        );
      }
      return { kind: 'text', mime: TEXT_EXTENSIONS[extension]! };
    }

    throw new AttachmentTypeError(
      `Unsupported attachment type for "${name}" (extension ${extension || 'none'}); allowed: images (png/jpg/webp/gif) and text files.`,
    );
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
