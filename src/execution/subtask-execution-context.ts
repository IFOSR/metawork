import {
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Subtask, Task, WorkspaceContext } from '../core/types.js';
import { ArtifactVersionRepo } from '../storage/artifact-version-repo.js';
import { resolveArtifactContentSync } from '../delivery/artifact-content-resolver.js';
import type { PersistedSubtaskHandoff } from '../storage/subtask-handoff-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { ContextRef, WorkGraphRequiredItem } from '../work-graph/index.js';
import { contextRefKey } from '../work-graph/index.js';
import {
  createEvidenceId,
  type ExecutionEvidencePort,
  ScopedExecutionEvidencePort,
  TaskExecutionEvidenceRepo,
} from './execution-evidence-port.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { COMPLETION_MARKER_V4 } from './completion-protocol.js';
import type { ExecutionEvidenceToolBinding } from './execution-evidence-tool-server.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import {
  ScopedExecutionResultReferencePort,
} from './execution-result-reference-port.js';
import { TaskArtifactRepo, hashContent } from '../storage/task-artifact-repo.js';
import type {
  GatewayAttachmentMetadata,
  GatewayAttachmentStore,
} from '../gateway/attachment-store-port.js';

export interface SelectedExecutionEvidence {
  ref: ContextRef;
  evidenceId: string;
  title: string;
  content: string;
  truncated: boolean;
}

export interface SelectedExecutionArtifact {
  ref: Extract<ContextRef, { kind: 'artifact' }>;
  artifactId: string;
  displayName: string;
  relativeInputPath: string;
  mediaType: string;
  contentHash: string;
}

function safeParseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boundText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export interface SelectedExecutionAttachment {
  ref: Extract<ContextRef, { kind: 'attachment' }>;
  attachmentId: string;
  displayName: string;
  relativeInputPath: string;
  mediaType: string;
  contentHash: string;
}

export interface PreviousRoundDiagnosis {
  taskId: string;
  goal: string;
  reasonCode: string | null;
  reason: string;
  operations: Array<{ kind: string; outcome: string; reasonCode: string | null; message: string }>;
}

export interface SubtaskExecutionContext {
  taskBackground: { id: string; title: string; goal: string; instruction: 'background_only' };
  currentSubtask: Pick<
    Subtask,
    'id' | 'title' | 'goal' | 'deliveryKind' | 'fileOutputs' | 'requiredCapabilities' | 'acceptance'
  >;
  incomingHandoffs: PersistedSubtaskHandoff[];
  outgoingHandoffRequirements: Array<{ toSubtaskId: string; requiredItems: WorkGraphRequiredItem[] }>;
  selectedEvidence: SelectedExecutionEvidence[];
  selectedArtifacts?: SelectedExecutionArtifact[];
  selectedAttachments?: SelectedExecutionAttachment[];
  outOfScopeSiblings: Array<{ id: string; title: string }>;
  workspaceContext: WorkspaceContext;
  identity: { executionId: string; taskId: string; subtaskId: string; attemptId: string; workUnitId: string };
  completionContract:
    | { marker: typeof COMPLETION_MARKER_V4; schemaVersion: 4 }
    | {
        marker: '---METACLAW-MERGE-REPAIR---';
        protocol: 'metaclaw:merge-repair:v1';
        allowedPaths: string[];
      };
  recovery?: {
    mode: 'native_session' | 'recovery_packet' | 'fresh';
    sourceAttemptId: string | null;
    packet: Record<string, unknown> | null;
  };
  /**
   * The most recent failed round in this Conversation's Workspace, when it is a
   * different Task (2026-10-27 realignment §5.3). A user who re-requests the
   * same goal gets the real diagnosis instead of repeating the failing command.
   */
  previousRound?: PreviousRoundDiagnosis;
  evidenceTools: {
    availability: 'available' | 'unavailable';
    reason: string;
    port?: ExecutionEvidencePort;
    binding?: ExecutionEvidenceToolBinding;
  };
}

export class SubtaskExecutionContextBuilder {
  private readonly evidenceRepo: TaskExecutionEvidenceRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;

  private readonly resultObjectRepo: ResultObjectRepo;
  private readonly artifactRepo: TaskArtifactRepo;

  constructor(
    private readonly db: Database.Database,
    options: {
      accountId?: string;
      resultRoot: string;
      attachmentStore?: GatewayAttachmentStore;
      /** `<objectsPath>/artifacts`: fixed ArtifactVersion bytes. */
      artifactObjectRoot?: string;
      /** Canonical root of the user Workspace, for `live_file` references. */
      resolveWorkspaceRoot?: () => Promise<string | null> | string | null;
    },
  ) {
    this.evidenceRepo = new TaskExecutionEvidenceRepo(db);
    this.handoffRepo = new SubtaskHandoffRepo(db);
    this.resultObjectRepo = new ResultObjectRepo(
      db,
      options.resultRoot,
    );
    this.artifactRepo = new TaskArtifactRepo(db);
    this.accountId = options.accountId ?? 'local-default';
    this.attachmentStore = options.attachmentStore;
    this.artifactObjectRoot = options.artifactObjectRoot;
    this.artifactVersionRepo = new ArtifactVersionRepo(db);
    this.resolveWorkspaceRoot = options.resolveWorkspaceRoot;
  }

  private readonly accountId: string;
  private readonly attachmentStore?: GatewayAttachmentStore;
  private readonly artifactObjectRoot?: string;
  private readonly artifactVersionRepo: ArtifactVersionRepo;
  private readonly resolveWorkspaceRoot?: () => Promise<string | null> | string | null;

  build(input: {
    executionId: string;
    task: Task;
    subtask: Subtask;
    allSubtasks: Subtask[];
    attemptId: string;
    workUnitId: string;
    sessionId: string;
    workspaceContext: WorkspaceContext;
    inputFilesPath?: string;
    evidenceToolsAvailable: boolean;
    currentSubtaskOverride?: Partial<SubtaskExecutionContext['currentSubtask']>;
    completionContractOverride?: SubtaskExecutionContext['completionContract'];
    recovery?: SubtaskExecutionContext['recovery'];
    evidenceToolBinding?: ExecutionEvidenceToolBinding;
  }): {
    context: SubtaskExecutionContext;
    evidenceCapability: ScopedExecutionEvidencePort;
    resultReferenceCapability: ScopedExecutionResultReferencePort;
  } {
    this.syncTaskEvidenceCatalog(input.task);
    const incomingHandoffs = this.handoffRepo.listIncoming(input.task.id, input.subtask.id);
    assertIncomingHandoffsComplete(input.subtask, incomingHandoffs);
    assertIncomingHandoffMaterialization(
      this.resultObjectRepo,
      input.task.id,
      input.subtask,
      incomingHandoffs,
    );
    const outgoingHandoffRequirements = input.allSubtasks.flatMap(candidate => {
      const dependency = candidate.dependencies.find(item => item.fromSubtaskId === input.subtask.id);
      return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
    });
    const selectedEvidence = this.resolveSelectedEvidence(input);
    const selectedArtifacts = this.resolveSelectedArtifacts({
      ...input,
      // Live references and historical copies are both addressed relative to the
      // Workspace the Attempt is authorized to read.
      workspaceRoot: input.workspaceContext.canonicalRoot ?? input.workspaceContext.workingDirectory,
    });
    const selectedAttachments = this.resolveSelectedAttachments(input, selectedArtifacts.length);
    const previousRound = this.resolvePreviousRound(input.task);
    const exactEvidenceIds = new Set(selectedEvidence
      .filter((item): item is SelectedExecutionEvidence & {
        ref: Extract<ContextRef, { kind: 'interaction'; side: 'assistant' }>;
      } => item.ref.kind === 'interaction' && item.ref.side === 'assistant')
      .map(item => item.evidenceId));
    const evidenceCapability = new ScopedExecutionEvidencePort(
      this.evidenceRepo,
      new TaskEventRepo(this.db),
      {
        taskId: input.task.id,
        subtaskId: input.subtask.id,
        attemptId: input.attemptId,
        exactEvidenceIds,
      },
    );
    const resultReferenceCapability = new ScopedExecutionResultReferencePort(
      this.resultObjectRepo,
      new TaskEventRepo(this.db),
      {
        accountId: this.accountId,
        taskId: input.task.id,
        generationId: input.subtask.generationId,
        subtaskId: input.subtask.id,
        attemptId: input.attemptId,
      },
    );
    return {
      evidenceCapability,
      resultReferenceCapability,
      context: {
        taskBackground: {
          id: input.task.id,
          title: input.task.title,
          goal: input.task.goal,
          instruction: 'background_only',
        },
        currentSubtask: {
          id: input.subtask.id,
          title: input.subtask.title,
          goal: input.subtask.goal,
          deliveryKind: input.subtask.deliveryKind,
          fileOutputs: input.subtask.fileOutputs,
          requiredCapabilities: input.subtask.requiredCapabilities,
          acceptance: input.subtask.acceptance,
          ...input.currentSubtaskOverride,
        },
        incomingHandoffs,
        outgoingHandoffRequirements,
        selectedEvidence,
        selectedArtifacts,
        selectedAttachments,
        outOfScopeSiblings: input.allSubtasks
          .filter(candidate => candidate.id !== input.subtask.id)
          .map(candidate => ({ id: candidate.id, title: candidate.title })),
        workspaceContext: input.workspaceContext,
        identity: {
          executionId: input.executionId,
          taskId: input.task.id,
          subtaskId: input.subtask.id,
          attemptId: input.attemptId,
          workUnitId: input.workUnitId,
        },
        completionContract: input.completionContractOverride
          ?? { marker: COMPLETION_MARKER_V4, schemaVersion: 4 },
        recovery: input.recovery,
        ...(previousRound ? { previousRound } : {}),
        evidenceTools: input.evidenceToolsAvailable
          ? {
              availability: 'available',
              reason: 'attempt-scoped evidence capability is active',
              port: evidenceCapability,
              binding: input.evidenceToolBinding,
            }
          : { availability: 'unavailable', reason: 'this Executor Adapter does not support the evidence tool protocol' },
      },
    };
  }

  /**
   * Diagnosis of the last failed round in this Task's Conversation.
   *
   * Bounded to one Task and four operation facts. It is context only: the new
   * Task keeps its own authorized graph, acceptance and Workspace binding, and
   * nothing here reopens, retries or re-authorized the earlier round.
   */
  private resolvePreviousRound(task: Task): PreviousRoundDiagnosis | null {
    if (!task.conversationId) return null;
    // A retry Task already carries its own continuation facts:
    // `task.retryOfTaskId` points at the round it continues.
    if (task.retryOfTaskId) return null;
    // Only the round that immediately preceded this Task can be "the previous
    // attempt": if any other Task was updated after it, this Task is unrelated
    // new work in the same Conversation and must not inherit its diagnosis.
    const row = this.db.prepare(`
      SELECT t.id, t.goal, t.state_detail_json
      FROM tasks t
      WHERE t.conversation_id = ? AND t.id <> ? AND t.status = 'failed'
        AND COALESCE(t.workspace_id, '') = COALESCE(?, '')
        AND NOT EXISTS (
          SELECT 1 FROM tasks newer
          WHERE newer.conversation_id = t.conversation_id
            AND newer.id NOT IN (t.id, ?)
            AND COALESCE(newer.workspace_id, '') = COALESCE(t.workspace_id, '')
            AND newer.updated_at > t.updated_at
        )
      ORDER BY t.updated_at DESC
      LIMIT 1
    `).get(
      task.conversationId,
      task.id,
      task.workspaceId ?? '',
      task.id,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const detail = typeof row.state_detail_json === 'string'
      ? safeParseRecord(row.state_detail_json)
      : {};
    const reason = detail.reason && typeof detail.reason === 'object'
      ? detail.reason as Record<string, unknown>
      : {};
    const operations = (this.db.prepare(`
      SELECT operation_kind, outcome, reason_code, message
      FROM task_operation_results
      WHERE task_id = ? AND outcome <> 'success'
      ORDER BY updated_at DESC
      LIMIT 4
    `).all(String(row.id)) as Array<Record<string, unknown>>).map(operation => ({
      kind: String(operation.operation_kind ?? ''),
      outcome: String(operation.outcome ?? ''),
      reasonCode: operation.reason_code ? String(operation.reason_code) : null,
      message: boundText(String(operation.message ?? ''), 400),
    }));
    return {
      taskId: String(row.id),
      goal: boundText(String(row.goal ?? ''), 600),
      reasonCode: typeof reason.code === 'string' && reason.code !== 'none' ? reason.code : null,
      reason: boundText(typeof reason.message === 'string' ? reason.message : '', 600),
      operations,
    };
  }

  private syncTaskEvidenceCatalog(task: Task): void {
    const interactions = this.db.prepare(`
      SELECT id, user_input, created_at
      FROM interactions
      WHERE task_id = ? AND TRIM(COALESCE(user_input, '')) <> ''
      ORDER BY created_at ASC, id ASC
    `).all(task.id) as Array<{ id: string; user_input: string; created_at: string }>;
    for (const interaction of interactions) {
      this.evidenceRepo.upsert({
        id: createEvidenceId('user_interaction', interaction.id),
        taskId: task.id,
        kind: 'user_input',
        sourceId: interaction.id,
        title: `User interaction ${interaction.id}`,
        content: interaction.user_input,
        createdAt: interaction.created_at,
      });
    }
    for (const locator of task.resources) {
      this.evidenceRepo.upsert({
        id: createEvidenceId('task_resource', locator),
        taskId: task.id,
        kind: 'task_resource',
        sourceId: locator,
        title: locator,
        content: readTaskResource(locator),
      });
    }
  }

  private resolveSelectedEvidence(input: {
    task: Task;
    subtask: Subtask;
    sessionId: string;
  }): SelectedExecutionEvidence[] {
    const refs = [...input.subtask.contextRefs]
      .filter((ref): ref is Exclude<ContextRef, { kind: 'artifact' | 'attachment' }> =>
        ref.kind !== 'artifact' && ref.kind !== 'attachment')
      .sort((left, right) => contextRefKey(left).localeCompare(contextRefKey(right)));
    const perRefBudget = Math.min(4_000, refs.length > 0 ? Math.floor(24_000 / refs.length) : 4_000);
    return refs.map(ref => this.resolveEvidenceRef(ref, input.task, input.sessionId, perRefBudget));
  }

  private resolveSelectedAttachments(
    input: {
      task: Task;
      subtask: Subtask;
      inputFilesPath?: string;
    },
    inputNameOffset: number,
  ): SelectedExecutionAttachment[] {
    const refs = input.subtask.contextRefs
      .filter((ref): ref is Extract<ContextRef, { kind: 'attachment' }> => ref.kind === 'attachment')
      .sort((left, right) => contextRefKey(left).localeCompare(contextRefKey(right)));
    if (refs.length === 0) return [];
    if (!this.attachmentStore) throw new Error('attachment_context_store_unavailable');
    if (!input.task.accountId || !input.task.conversationId || !input.task.workspaceId) {
      throw new Error('attachment_context_task_identity_missing');
    }
    if (input.task.accountId !== this.accountId) {
      throw new Error(`attachment_context_wrong_account: ${input.task.accountId}`);
    }

    const selected: SelectedExecutionAttachment[] = [];
    for (const [index, ref] of refs.entries()) {
      const attachment: ReturnType<
        NonNullable<GatewayAttachmentStore['readAttachmentSync']>
      > | null = this.attachmentStore.readAttachmentSync?.(
        input.task.conversationId,
        ref.attachmentId,
      ) ?? null;
      if (!attachment) throw new Error(`attachment_context_not_found: ${ref.attachmentId}`);
      const metadata: GatewayAttachmentMetadata = attachment.metadata;
      const { bytes } = attachment;
      if (metadata.accountId !== input.task.accountId) {
        throw new Error(`attachment_context_wrong_account: ${ref.attachmentId}`);
      }
      if (metadata.conversationId !== input.task.conversationId) {
        throw new Error(`attachment_context_wrong_conversation: ${ref.attachmentId}`);
      }
      if (metadata.workspaceId !== input.task.workspaceId) {
        throw new Error(`attachment_context_wrong_workspace: ${ref.attachmentId}`);
      }
      if (metadata.status !== 'available') {
        throw new Error(`attachment_context_unavailable: ${ref.attachmentId}`);
      }
      if (metadata.size !== bytes.byteLength) {
        throw new Error(`attachment_context_size_mismatch: ${ref.attachmentId}`);
      }
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== metadata.sha256) {
        throw new Error(`attachment_context_content_hash_mismatch: ${ref.attachmentId}`);
      }
      const relativeInputPath = safeInputAttachmentName(
        metadata.name,
        inputNameOffset + index,
      );
      if (input.inputFilesPath) {
        mkdirSync(input.inputFilesPath, { recursive: true });
        materializeAttachmentFile(
          join(input.inputFilesPath, relativeInputPath),
          bytes,
          actualHash,
        );
      }
      selected.push({
        ref,
        attachmentId: ref.attachmentId,
        displayName: metadata.name,
        relativeInputPath,
        mediaType: metadata.mime,
        contentHash: actualHash,
      });
    }
    return selected;
  }

  private resolveSelectedArtifacts(input: {
    task: Task;
    subtask: Subtask;
    inputFilesPath?: string;
    workspaceRoot?: string;
  }): SelectedExecutionArtifact[] {
    const refs = input.subtask.contextRefs
      .filter((ref): ref is Extract<ContextRef, { kind: 'artifact' }> => ref.kind === 'artifact')
      .sort((left, right) => contextRefKey(left).localeCompare(contextRefKey(right)));
    if (refs.length === 0) return [];
    if (!input.task.accountId || !input.task.conversationId) {
      throw new Error('artifact_context_task_identity_missing');
    }

    return refs.map((ref, index) => {
      const artifact = this.artifactRepo.findById(ref.artifactId);
      if (!artifact) throw new Error(`artifact_context_not_found: ${ref.artifactId}`);
      if (artifact.status !== 'published') {
        throw new Error(`artifact_context_unavailable: ${ref.artifactId}`);
      }
      const sourceTask = this.db.prepare(`
        SELECT account_id, conversation_id, workspace_id
        FROM tasks WHERE id = ?
      `).get(artifact.taskId) as {
        account_id: string;
        conversation_id: string;
        workspace_id: string;
      } | undefined;
      if (
        !sourceTask
        || sourceTask.account_id !== input.task.accountId
        || sourceTask.conversation_id !== input.task.conversationId
        || (
          input.task.workspaceId
          && sourceTask.workspace_id !== input.task.workspaceId
        )
      ) {
        throw new Error(`artifact_context_wrong_conversation: ${ref.artifactId}`);
      }
      // Read by reference kind: a fixed version comes from the CAS so a later
      // edit to the live file cannot change this handoff, while a live
      // reference reads the current Workspace file and reports its observed
      // hash instead of pretending the recorded hash still authorizes it.
      const artifactVersion = artifact.referenceKind === 'artifact_version' && artifact.artifactVersionId
        ? this.artifactVersionRepo.find(artifact.artifactVersionId)
        : null;
      const content = resolveArtifactContentSync({
        artifact,
        artifactVersion,
        objectRoot: this.artifactObjectRoot ?? null,
        workspaceRoot: artifact.referenceKind === 'live_file'
          ? (input.workspaceRoot ?? null)
          : null,
        // A legacy copy is read from its recorded absolute path, so it must be
        // proven to live inside an authorized Workspace first.
        containmentRoots: artifact.referenceKind === 'legacy_published_copy'
          ? [input.workspaceRoot].filter((root): root is string => Boolean(root))
          : undefined,
        expectedAccountId: this.accountId,
        expectedWorkspaceId: artifact.workspaceId ?? input.task.workspaceId ?? null,
      });
      const relativeInputPath = safeInputArtifactName(artifact.displayName, index);
      if (input.inputFilesPath) {
        mkdirSync(input.inputFilesPath, { recursive: true });
        materializeArtifactBytes(
          content.bytes,
          join(input.inputFilesPath, relativeInputPath),
          content.contentHash,
        );
      }
      return {
        ref,
        artifactId: artifact.artifactId,
        displayName: artifact.displayName,
        relativeInputPath,
        mediaType: artifact.mediaType,
        contentHash: content.contentHash,
      };
    });
  }

  private resolveEvidenceRef(
    ref: ContextRef,
    task: Task,
    sessionId: string,
    budget: number,
  ): SelectedExecutionEvidence {
    let evidenceId: string;
    let title: string;
    let content: string;
    let exactOnly = false;
    if (ref.kind === 'current_user_input') {
      evidenceId = createEvidenceId('current_user_input', task.id);
      const row = this.evidenceRepo.findForTask(task.id, evidenceId);
      if (!row) throw new Error('current_user_input evidence was not materialized with the work graph');
      title = 'Current user input';
      content = row.content;
    } else if (ref.kind === 'task_resource') {
      if (!task.resources.includes(ref.locator)) throw new Error(`task_resource_not_authorized: ${ref.locator}`);
      evidenceId = createEvidenceId('task_resource', ref.locator);
      title = ref.locator;
      content = readTaskResource(ref.locator);
      this.evidenceRepo.upsert({ id: evidenceId, taskId: task.id, kind: 'task_resource', sourceId: ref.locator, title, content });
    } else if (ref.kind === 'memory') {
      // Long-term memory is materialized by the Runtime before the attempt
      // starts. If it is missing, the evidence is unavailable and the attempt
      // fails explicitly — an empty body is never passed off as evidence.
      evidenceId = createEvidenceId('long_term_memory', ref.memoryId);
      const row = this.evidenceRepo.findForTask(task.id, evidenceId);
      if (!row || row.kind !== 'long_term_memory') {
        throw new Error(`memory_not_authorized: ${ref.memoryId}`);
      }
      title = row.title;
      content = row.content;
    } else if (ref.kind === 'task_evidence') {
      const row = this.evidenceRepo.findForTask(task.id, ref.evidenceId);
      if (!row || row.kind !== 'task_evidence') throw new Error(`task_evidence_not_authorized: ${ref.evidenceId}`);
      evidenceId = row.id;
      title = row.title;
      content = row.content;
    } else if (ref.kind === 'interaction') {
      // Revalidate the selected source and repair a missing task association on recovery.
      evidenceId = this.evidenceRepo.materializeInteraction({
        taskId: task.id,
        sessionId,
        interactionId: ref.interactionId,
        side: ref.side,
      });
      const materialized = this.evidenceRepo.findForTask(task.id, evidenceId)!;
      title = materialized.title;
      content = materialized.content;
      exactOnly = ref.side === 'assistant';
    } else {
      throw new Error(`context_ref_not_supported: ${ref.kind}`);
    }
    const truncated = content.length > budget;
    // The marker is part of the budget: the preview must never exceed it.
    const marker = '\n[TRUNCATED: use evidence get for remaining content]';
    const preview = truncated
      ? `${content.slice(0, Math.max(0, budget - marker.length))}${marker}`
      : content;
    return { ref, evidenceId, title, content: preview, truncated };
  }
}

function readTaskResource(locator: string): string {
  if (!existsSync(locator)) return locator;
  try {
    const info = statSync(locator);
    if (!info.isFile()) return `[任务资源不是普通文件：${locator}]`;
    const sample = Buffer.alloc(Math.min(info.size, 8 * 1024));
    const handle = openSync(locator, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(handle, sample, 0, sample.length, 0);
    } finally {
      closeSync(handle);
    }
    if (isBinaryTaskResource(locator, sample.subarray(0, bytesRead))) {
      return `[二进制任务资源，未注入文本提示词：${locator}]`;
    }
    return readFileSync(locator, 'utf8').replace(/\u0000/gu, '');
  } catch {
    return `[Resource is not readable as UTF-8 text: ${locator}]`;
  }
}

function safeInputArtifactName(name: string, index: number): string {
  const normalized = basename(name).normalize('NFC')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.{1,2}$/u, '_')
    .slice(-160);
  return `input-${String(index + 1).padStart(2, '0')}-${normalized || 'artifact'}`;
}

function safeInputAttachmentName(name: string, index: number): string {
  const normalized = basename(name).normalize('NFC')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.{1,2}$/u, '_')
    .slice(-160);
  return `input-${String(index + 1).padStart(2, '0')}-${normalized || 'attachment'}`;
}

function materializeAttachmentFile(
  destinationPath: string,
  bytes: Buffer,
  expectedHash: string,
): void {
  if (existsSync(destinationPath)) {
    const existing = lstatSync(destinationPath, { throwIfNoEntry: false });
    if (!existing?.isFile() || existing.isSymbolicLink()) {
      throw new Error(`attachment_context_destination_invalid: ${destinationPath}`);
    }
    const existingHash = createHash('sha256').update(readFileSync(destinationPath)).digest('hex');
    if (existingHash !== expectedHash) {
      throw new Error(`attachment_context_destination_hash_mismatch: ${destinationPath}`);
    }
    return;
  }
  writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
}

function materializeArtifactBytes(
  bytes: Buffer,
  destinationPath: string,
  expectedHash: string,
): void {
  if (existsSync(destinationPath)) {
    const existing = lstatSync(destinationPath, { throwIfNoEntry: false });
    if (!existing?.isFile() || existing.isSymbolicLink()) {
      throw new Error(`artifact_context_destination_invalid: ${destinationPath}`);
    }
    if (hashContent(readFileSync(destinationPath)) !== expectedHash) {
      throw new Error(`artifact_context_destination_hash_mismatch: ${destinationPath}`);
    }
    return;
  }
  writeFileSync(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
}

const BINARY_RESOURCE_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.doc', '.docx', '.gif', '.gz', '.ico', '.jpeg', '.jpg',
  '.mov', '.mp3', '.mp4', '.mpeg', '.pdf', '.png', '.ppt', '.pptx', '.rar', '.tar',
  '.tif', '.tiff', '.wav', '.webm', '.webp', '.xls', '.xlsx', '.zip',
]);

function isBinaryTaskResource(locator: string, sample: Buffer): boolean {
  if (BINARY_RESOURCE_EXTENSIONS.has(extname(locator).toLowerCase())) return true;
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

function assertIncomingHandoffsComplete(subtask: Subtask, handoffs: PersistedSubtaskHandoff[]): void {
  const actual = new Set(handoffs.map(handoff => handoff.fromSubtaskId));
  const missing = subtask.dependencies
    .map(dependency => dependency.fromSubtaskId)
    .filter(dependencyId => !actual.has(dependencyId));
  if (missing.length > 0) throw new Error(`incoming_handoff_missing: ${missing.join(', ')}`);
}

function assertIncomingHandoffMaterialization(
  resultObjectRepo: ResultObjectRepo,
  taskId: string,
  subtask: Subtask,
  handoffs: PersistedSubtaskHandoff[],
): void {
  for (const handoff of handoffs) {
    const referenceItem = handoff.items.find(item => item.type === 'result_reference');
    if (!referenceItem) continue;
    const reference = handoff.resultReference;
    if (
      !reference
      || reference.referenceId !== referenceItem.referenceId
      || reference.taskId !== taskId
      || reference.targetSubtaskId !== subtask.id
      || reference.sourceSubtaskId !== handoff.fromSubtaskId
      || reference.generationId !== subtask.generationId
    ) {
      throw new Error(
        `dependency_identity_mismatch: ${handoff.fromSubtaskId} -> ${subtask.id}`,
      );
    }
    if (!resultObjectRepo.findObject(reference.resultId)) {
      throw new Error(
        `dependency_result_object_missing: ${reference.resultId}`,
      );
    }
    const persistedReference = resultObjectRepo.findReference(reference.referenceId);
    if (
      !persistedReference
      || persistedReference.resultId !== reference.resultId
      || persistedReference.targetSubtaskId !== subtask.id
    ) {
      throw new Error(
        `dependency_result_reference_unauthorized: ${reference.referenceId}`,
      );
    }
  }
}
