import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

export type ResultObjectKind = 'raw_attempt_output' | 'business_result' | 'safe_projection';
export type ResultCompleteness = 'complete' | 'partial' | 'incomplete';

export interface ResultObjectRecord {
  resultId: string;
  accountId: string;
  taskId: string;
  generationId: string;
  sourceSubtaskId: string;
  attemptId: string;
  kind: ResultObjectKind;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  storageUri: string;
  completeness: ResultCompleteness;
  retentionClass: string;
  createdAt: string;
}

export interface ResultReferenceRecord {
  referenceId: string;
  resultId: string;
  accountId: string;
  taskId: string;
  generationId: string;
  sourceSubtaskId: string;
  targetSubtaskId: string;
  edgeKey: string;
  requiredItems: string[];
  readScope: {
    kind: 'direct_dependency';
    offset: number;
    length: number;
    summaryHash: string;
  };
  contentHash: string;
  byteLength: number;
  mediaType: string;
  completeness: ResultCompleteness;
  createdAt: string;
}

export interface ResultRead {
  resultId: string;
  offset: number;
  content: string;
  contentHash: string;
  complete: boolean;
}

export interface ResultObjectWriter {
  readonly resultId: string;
  readonly byteLength: number;
  append(chunk: string | Uint8Array): void;
  finalize(completeness: ResultCompleteness): ResultObjectRecord;
  discard(): void;
}

export class ResultObjectRepo {
  private readonly objectRoot: string;
  private readonly stagingRoot: string;

  constructor(
    private readonly db: Database.Database,
    root: string,
  ) {
    this.objectRoot = join(root, 'objects');
    this.stagingRoot = join(root, 'staging');
    mkdirSync(this.objectRoot, { recursive: true });
    mkdirSync(this.stagingRoot, { recursive: true });
    this.recoverStaging();
  }

  createWriter(input: {
    resultId: string;
    accountId: string;
    taskId: string;
    generationId: string;
    sourceSubtaskId: string;
    attemptId: string;
    kind: ResultObjectKind;
    mediaType: string;
    retentionClass: string;
    createdAt?: string;
  }): ResultObjectWriter {
    const existing = this.findObject(input.resultId);
    if (existing) {
      return completedWriter(existing);
    }
    const stagingId = createHash('sha256').update(input.resultId).digest('hex');
    const temporaryPath = join(
      this.stagingRoot,
      `${stagingId}.${process.pid}.${Date.now()}.tmp`,
    );
    const metadataPath = `${temporaryPath}.meta.json`;
    writeFileSync(metadataPath, JSON.stringify({
      ...input,
      processId: process.pid,
    }), { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    let closed = false;
    let finalized: ResultObjectRecord | null = null;
    const close = () => {
      if (closed) return;
      closeSync(descriptor);
      closed = true;
    };
    return {
      resultId: input.resultId,
      get byteLength() {
        return finalized?.byteLength ?? byteLength;
      },
      append: chunk => {
        if (closed) throw new Error(`result object writer is closed: ${input.resultId}`);
        const bytes = Buffer.from(chunk);
        if (bytes.byteLength === 0) return;
        writeSync(descriptor, bytes);
        hash.update(bytes);
        byteLength += bytes.byteLength;
      },
      finalize: completeness => {
        if (finalized) return finalized;
        close();
        const contentHash = `sha256:${hash.digest('hex')}`;
        finalized = this.commitStagedObject({
          ...input,
          contentHash,
          byteLength,
          completeness,
          temporaryPath,
          metadataPath,
        });
        return finalized;
      },
      discard: () => {
        if (finalized) return;
        close();
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        if (existsSync(metadataPath)) unlinkSync(metadataPath);
      },
    };
  }

  putObject(input: {
    resultId: string;
    accountId: string;
    taskId: string;
    generationId: string;
    sourceSubtaskId: string;
    attemptId: string;
    kind: ResultObjectKind;
    mediaType: string;
    content: string;
    completeness: ResultCompleteness;
    retentionClass: string;
    createdAt?: string;
  }): ResultObjectRecord {
    const bytes = Buffer.from(input.content, 'utf8');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const existing = this.findObject(input.resultId);
    if (existing) {
      if (existing.contentHash === contentHash && existing.byteLength === bytes.byteLength) {
        return existing;
      }
      throw new Error(`result object is immutable: ${input.resultId}`);
    }
    const objectName = contentHash.slice('sha256:'.length);
    const storageUri = `objects/${objectName}`;
    const objectPath = join(this.objectRoot, objectName);
    if (!existsSync(objectPath)) {
      const temporaryPath = `${objectPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryPath, bytes, { flag: 'wx' });
      renameSync(temporaryPath, objectPath);
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO result_objects (
        result_id, account_id, task_id, generation_id, source_subtask_id,
        attempt_id, kind, content_hash, byte_length, media_type, storage_uri,
        completeness, retention_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.resultId,
      input.accountId,
      input.taskId,
      input.generationId,
      input.sourceSubtaskId,
      input.attemptId,
      input.kind,
      contentHash,
      bytes.byteLength,
      input.mediaType,
      storageUri,
      input.completeness,
      input.retentionClass,
      createdAt,
    );
    return {
      resultId: input.resultId,
      accountId: input.accountId,
      taskId: input.taskId,
      generationId: input.generationId,
      sourceSubtaskId: input.sourceSubtaskId,
      attemptId: input.attemptId,
      kind: input.kind,
      contentHash,
      byteLength: bytes.byteLength,
      mediaType: input.mediaType,
      storageUri,
      completeness: input.completeness,
      retentionClass: input.retentionClass,
      createdAt,
    };
  }

  findObject(resultId: string): ResultObjectRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM result_objects WHERE result_id = ?',
    ).get(resultId) as Record<string, unknown> | undefined;
    return row ? resultObjectFromRow(row) : null;
  }

  findObjectByAttempt(input: {
    accountId: string;
    taskId: string;
    attemptId: string;
    kind: ResultObjectKind;
  }): ResultObjectRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM result_objects
      WHERE account_id = ? AND task_id = ? AND attempt_id = ? AND kind = ?
      ORDER BY created_at DESC, result_id ASC
      LIMIT 1
    `).get(
      input.accountId,
      input.taskId,
      input.attemptId,
      input.kind,
    ) as Record<string, unknown> | undefined;
    return row ? resultObjectFromRow(row) : null;
  }

  readRange(resultId: string, offset: number, length: number): ResultRead {
    const object = this.findObject(resultId);
    if (!object) throw new Error(`result object not found: ${resultId}`);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
      throw new Error('result range must use non-negative integer offset and length');
    }
    const bytes = readFileSync(this.pathFor(object));
    const slice = bytes.subarray(offset, Math.min(offset + length, bytes.byteLength));
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
      throw new Error(`result range does not align to UTF-8 boundaries: ${resultId}`);
    }
    return {
      resultId,
      offset,
      content,
      contentHash: object.contentHash,
      complete: offset + slice.byteLength >= object.byteLength,
    };
  }

  createReference(input: {
    referenceId: string;
    resultId: string;
    accountId: string;
    taskId: string;
    generationId: string;
    sourceSubtaskId: string;
    targetSubtaskId: string;
    edgeKey: string;
    requiredItems: string[];
    readScope: ResultReferenceRecord['readScope'];
    createdAt?: string;
  }): ResultReferenceRecord {
    const result = this.findObject(input.resultId);
    if (!result) throw new Error(`result object not found: ${input.resultId}`);
    if (
      result.accountId !== input.accountId
      || result.taskId !== input.taskId
      || result.generationId !== input.generationId
      || result.sourceSubtaskId !== input.sourceSubtaskId
    ) {
      throw new Error('result reference identity does not match result object');
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO result_references (
        reference_id, result_id, account_id, task_id, generation_id,
        source_subtask_id, target_subtask_id, edge_key, required_items_json,
        read_scope_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.referenceId,
      input.resultId,
      input.accountId,
      input.taskId,
      input.generationId,
      input.sourceSubtaskId,
      input.targetSubtaskId,
      input.edgeKey,
      JSON.stringify(input.requiredItems),
      JSON.stringify(input.readScope),
      createdAt,
    );
    return {
      referenceId: input.referenceId,
      resultId: input.resultId,
      accountId: input.accountId,
      taskId: input.taskId,
      generationId: input.generationId,
      sourceSubtaskId: input.sourceSubtaskId,
      targetSubtaskId: input.targetSubtaskId,
      edgeKey: input.edgeKey,
      requiredItems: [...input.requiredItems],
      readScope: input.readScope,
      contentHash: result.contentHash,
      byteLength: result.byteLength,
      mediaType: result.mediaType,
      completeness: result.completeness,
      createdAt,
    };
  }

  findReference(referenceId: string): ResultReferenceRecord | null {
    const row = this.db.prepare(`
      SELECT reference.*, result.content_hash, result.byte_length,
             result.media_type, result.completeness
      FROM result_references reference
      INNER JOIN result_objects result ON result.result_id = reference.result_id
      WHERE reference.reference_id = ?
    `).get(referenceId) as Record<string, unknown> | undefined;
    return row ? resultReferenceFromRow(row) : null;
  }

  listReferencesForTarget(input: {
    accountId: string;
    taskId: string;
    generationId: string;
    targetSubtaskId: string;
  }): ResultReferenceRecord[] {
    const rows = this.db.prepare(`
      SELECT reference.*, result.content_hash, result.byte_length,
             result.media_type, result.completeness
      FROM result_references reference
      INNER JOIN result_objects result ON result.result_id = reference.result_id
      WHERE reference.account_id = ?
        AND reference.task_id = ?
        AND reference.generation_id = ?
        AND reference.target_subtask_id = ?
      ORDER BY reference.source_subtask_id ASC, reference.reference_id ASC
    `).all(
      input.accountId,
      input.taskId,
      input.generationId,
      input.targetSubtaskId,
    ) as Record<string, unknown>[];
    return rows.map(resultReferenceFromRow);
  }

  readReferenceRange(input: {
    referenceId: string;
    accountId: string;
    taskId: string;
    generationId: string;
    sourceSubtaskId: string;
    targetSubtaskId: string;
    offset: number;
    length: number;
  }): ResultRead {
    const reference = this.findReference(input.referenceId);
    if (!reference) throw new Error(`result reference not found: ${input.referenceId}`);
    if (
      reference.accountId !== input.accountId
      || reference.taskId !== input.taskId
      || reference.generationId !== input.generationId
      || reference.sourceSubtaskId !== input.sourceSubtaskId
      || reference.targetSubtaskId !== input.targetSubtaskId
    ) {
      throw new Error(`result reference is not authorized for target ${input.targetSubtaskId}`);
    }
    const allowedStart = reference.readScope.offset;
    const allowedEnd = allowedStart + reference.readScope.length;
    if (input.offset < allowedStart || input.offset + input.length > allowedEnd) {
      throw new Error(`result reference range is not authorized: ${input.referenceId}`);
    }
    return this.readRange(reference.resultId, input.offset, input.length);
  }

  private pathFor(object: ResultObjectRecord): string {
    const path = join(this.objectRoot, object.storageUri.slice('objects/'.length));
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`result object storage is not a file: ${object.resultId}`);
    return path;
  }

  private commitStagedObject(input: {
    resultId: string;
    accountId: string;
    taskId: string;
    generationId: string;
    sourceSubtaskId: string;
    attemptId: string;
    kind: ResultObjectKind;
    mediaType: string;
    retentionClass: string;
    createdAt?: string;
    contentHash: string;
    byteLength: number;
    completeness: ResultCompleteness;
    temporaryPath: string;
    metadataPath?: string;
  }): ResultObjectRecord {
    const existing = this.findObject(input.resultId);
    if (existing) {
      if (
        existing.contentHash !== input.contentHash
        || existing.byteLength !== input.byteLength
      ) {
        throw new Error(`result object is immutable: ${input.resultId}`);
      }
      if (existsSync(input.temporaryPath)) unlinkSync(input.temporaryPath);
      if (input.metadataPath && existsSync(input.metadataPath)) unlinkSync(input.metadataPath);
      return existing;
    }
    const objectName = input.contentHash.slice('sha256:'.length);
    const storageUri = `objects/${objectName}`;
    const objectPath = join(this.objectRoot, objectName);
    if (existsSync(objectPath)) unlinkSync(input.temporaryPath);
    else renameSync(input.temporaryPath, objectPath);
    if (input.metadataPath && existsSync(input.metadataPath)) unlinkSync(input.metadataPath);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO result_objects (
        result_id, account_id, task_id, generation_id, source_subtask_id,
        attempt_id, kind, content_hash, byte_length, media_type, storage_uri,
        completeness, retention_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.resultId,
      input.accountId,
      input.taskId,
      input.generationId,
      input.sourceSubtaskId,
      input.attemptId,
      input.kind,
      input.contentHash,
      input.byteLength,
      input.mediaType,
      storageUri,
      input.completeness,
      input.retentionClass,
      createdAt,
    );
    return {
      resultId: input.resultId,
      accountId: input.accountId,
      taskId: input.taskId,
      generationId: input.generationId,
      sourceSubtaskId: input.sourceSubtaskId,
      attemptId: input.attemptId,
      kind: input.kind,
      contentHash: input.contentHash,
      byteLength: input.byteLength,
      mediaType: input.mediaType,
      storageUri,
      completeness: input.completeness,
      retentionClass: input.retentionClass,
      createdAt,
    };
  }

  private recoverStaging(): void {
    for (const metadataName of readdirSync(this.stagingRoot).filter(name => name.endsWith('.tmp.meta.json'))) {
      const metadataPath = join(this.stagingRoot, metadataName);
      const temporaryPath = metadataPath.slice(0, -'.meta.json'.length);
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
          resultId?: string;
          accountId?: string;
          taskId?: string;
          generationId?: string;
          sourceSubtaskId?: string;
          attemptId?: string;
          kind?: ResultObjectKind;
          mediaType?: string;
          retentionClass?: string;
          createdAt?: string;
          processId?: number;
        };
        const stagingPid = Number(metadataName.split('.')[1]);
        if (stagingPid === process.pid) continue;
        if (!metadata.resultId || !metadata.accountId || !metadata.taskId
          || !metadata.generationId || !metadata.sourceSubtaskId || !metadata.attemptId
          || !metadata.kind || !metadata.mediaType || !metadata.retentionClass) {
          continue;
        }
        if (!existsSync(temporaryPath)) {
          unlinkSync(metadataPath);
          continue;
        }
        const { contentHash, byteLength } = hashFileSync(temporaryPath);
        this.commitStagedObject({
          resultId: metadata.resultId,
          accountId: metadata.accountId,
          taskId: metadata.taskId,
          generationId: metadata.generationId,
          sourceSubtaskId: metadata.sourceSubtaskId,
          attemptId: metadata.attemptId,
          kind: metadata.kind,
          mediaType: metadata.mediaType,
          retentionClass: metadata.retentionClass,
          createdAt: metadata.createdAt,
          contentHash,
          byteLength,
          completeness: 'incomplete',
          temporaryPath,
          metadataPath,
        });
      } catch {
        // Leave malformed staging entries for a later diagnostic/cleanup pass.
      }
    }
  }
}

function hashFileSync(path: string): { contentHash: string; byteLength: number } {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteLength = 0;
  try {
    let read = 0;
    do {
      read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read > 0) {
        hash.update(buffer.subarray(0, read));
        byteLength += read;
      }
    } while (read > 0);
  } finally {
    closeSync(descriptor);
  }
  return { contentHash: `sha256:${hash.digest('hex')}`, byteLength };
}

function completedWriter(record: ResultObjectRecord): ResultObjectWriter {
  return {
    resultId: record.resultId,
    byteLength: record.byteLength,
    append: () => {
      throw new Error(`result object writer is closed: ${record.resultId}`);
    },
    finalize: () => record,
    discard: () => undefined,
  };
}

function resultReferenceFromRow(row: Record<string, unknown>): ResultReferenceRecord {
  return {
    referenceId: String(row.reference_id),
    resultId: String(row.result_id),
    accountId: String(row.account_id),
    taskId: String(row.task_id),
    generationId: String(row.generation_id),
    sourceSubtaskId: String(row.source_subtask_id),
    targetSubtaskId: String(row.target_subtask_id),
    edgeKey: String(row.edge_key),
    requiredItems: JSON.parse(String(row.required_items_json)) as string[],
    readScope: JSON.parse(String(row.read_scope_json)) as ResultReferenceRecord['readScope'],
    contentHash: String(row.content_hash),
    byteLength: Number(row.byte_length),
    mediaType: String(row.media_type),
    completeness: row.completeness as ResultCompleteness,
    createdAt: String(row.created_at),
  };
}

function resultObjectFromRow(row: Record<string, unknown>): ResultObjectRecord {
  return {
    resultId: String(row.result_id),
    accountId: String(row.account_id),
    taskId: String(row.task_id),
    generationId: String(row.generation_id),
    sourceSubtaskId: String(row.source_subtask_id),
    attemptId: String(row.attempt_id),
    kind: row.kind as ResultObjectKind,
    contentHash: String(row.content_hash),
    byteLength: Number(row.byte_length),
    mediaType: String(row.media_type),
    storageUri: String(row.storage_uri),
    completeness: row.completeness as ResultCompleteness,
    retentionClass: String(row.retention_class),
    createdAt: String(row.created_at),
  };
}
