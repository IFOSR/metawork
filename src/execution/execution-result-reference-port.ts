import type { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import type {
  ResultObjectRepo,
  ResultReferenceRecord,
} from '../storage/result-object-repo.js';

const RESULT_CHUNK_BYTES = 12_000;

export interface ResultReferenceDescriptor {
  referenceId: string;
  sourceSubtaskId: string;
  requiredItems: string[];
  contentHash: string;
  byteLength: number;
  mediaType: string;
  completeness: 'complete' | 'partial' | 'incomplete';
}

export interface ResultReferenceChunk {
  referenceId: string;
  content: string;
  offset: number;
  nextOffset: number | null;
  contentHash: string;
  complete: boolean;
}

export interface ExecutionResultReferencePort {
  list(): { items: ResultReferenceDescriptor[] };
  get(input: { referenceId: string; offset?: number }): ResultReferenceChunk;
  revoke(): void;
}

export class ScopedExecutionResultReferencePort implements ExecutionResultReferencePort {
  private active = true;
  private readonly events: TaskEventRecorder;

  constructor(
    private readonly repo: ResultObjectRepo,
    taskEventRepo: TaskEventRepo,
    private readonly scope: {
      accountId: string;
      taskId: string;
      generationId: string;
      subtaskId: string;
      attemptId: string;
    },
  ) {
    this.events = new TaskEventRecorder(taskEventRepo);
  }

  revoke(): void {
    this.active = false;
  }

  list(): { items: ResultReferenceDescriptor[] } {
    this.assertActive();
    const references = this.references();
    this.audit('list', null, references.length);
    return { items: references.map(toDescriptor) };
  }

  get(input: { referenceId: string; offset?: number }): ResultReferenceChunk {
    this.assertActive();
    const reference = this.references().find(item => item.referenceId === input.referenceId);
    if (!reference) {
      this.audit('get_denied', input.referenceId, 0);
      throw new Error('result_reference_not_authorized');
    }
    const offset = Math.max(reference.readScope.offset, Math.floor(input.offset ?? 0));
    const allowedEnd = reference.readScope.offset + reference.readScope.length;
    const requestedLength = Math.min(RESULT_CHUNK_BYTES, Math.max(0, allowedEnd - offset));
    const read = readUtf8Chunk(this.repo, reference, offset, requestedLength);
    const consumedBytes = Buffer.byteLength(read.content, 'utf8');
    const nextOffset = offset + consumedBytes < allowedEnd ? offset + consumedBytes : null;
    this.audit('get', input.referenceId, read.content ? 1 : 0);
    return {
      referenceId: reference.referenceId,
      content: read.content,
      offset,
      nextOffset,
      contentHash: reference.contentHash,
      complete: nextOffset === null,
    };
  }

  private references(): ResultReferenceRecord[] {
    return this.repo.listReferencesForTarget({
      accountId: this.scope.accountId,
      taskId: this.scope.taskId,
      generationId: this.scope.generationId,
      targetSubtaskId: this.scope.subtaskId,
    });
  }

  private assertActive(): void {
    if (!this.active) throw new Error('result_reference_capability_expired');
  }

  private audit(queryType: string, reference: string | null, resultCount: number): void {
    this.events.record(
      this.scope.taskId,
      this.scope.subtaskId,
      'executor_result_reference_accessed',
      queryType,
      { attemptId: this.scope.attemptId, queryType, reference, resultCount },
    );
  }
}

function toDescriptor(reference: ResultReferenceRecord): ResultReferenceDescriptor {
  return {
    referenceId: reference.referenceId,
    sourceSubtaskId: reference.sourceSubtaskId,
    requiredItems: [...reference.requiredItems],
    contentHash: reference.contentHash,
    byteLength: reference.byteLength,
    mediaType: reference.mediaType,
    completeness: reference.completeness,
  };
}

function readUtf8Chunk(
  repo: ResultObjectRepo,
  reference: ResultReferenceRecord,
  offset: number,
  requestedLength: number,
) {
  for (let length = requestedLength; length >= Math.max(0, requestedLength - 3); length -= 1) {
    try {
      return repo.readReferenceRange({
        referenceId: reference.referenceId,
        accountId: reference.accountId,
        taskId: reference.taskId,
        generationId: reference.generationId,
        sourceSubtaskId: reference.sourceSubtaskId,
        targetSubtaskId: reference.targetSubtaskId,
        offset,
        length,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('UTF-8 boundaries')) throw error;
    }
  }
  throw new Error(`result reference range does not align to UTF-8 boundaries: ${reference.referenceId}`);
}
