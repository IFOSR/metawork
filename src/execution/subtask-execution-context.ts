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
} from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Subtask, Task, WorkspaceContext } from '../core/types.js';
import { PreferenceRepo } from '../storage/preference-repo.js';
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

export interface SubtaskExecutionContext {
  taskBackground: { id: string; title: string; goal: string; instruction: 'background_only' };
  currentSubtask: Pick<
    Subtask,
    'id' | 'title' | 'goal' | 'deliveryKind' | 'requiredCapabilities' | 'acceptance'
  >;
  incomingHandoffs: PersistedSubtaskHandoff[];
  outgoingHandoffRequirements: Array<{ toSubtaskId: string; requiredItems: WorkGraphRequiredItem[] }>;
  selectedEvidence: SelectedExecutionEvidence[];
  selectedArtifacts?: SelectedExecutionArtifact[];
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
  private readonly preferenceRepo: PreferenceRepo;

  private readonly resultObjectRepo: ResultObjectRepo;
  private readonly artifactRepo: TaskArtifactRepo;

  constructor(
    private readonly db: Database.Database,
    options: { accountId?: string; resultRoot: string },
  ) {
    this.evidenceRepo = new TaskExecutionEvidenceRepo(db);
    this.handoffRepo = new SubtaskHandoffRepo(db);
    this.preferenceRepo = new PreferenceRepo(db);
    this.resultObjectRepo = new ResultObjectRepo(
      db,
      options.resultRoot,
    );
    this.artifactRepo = new TaskArtifactRepo(db);
    this.accountId = options.accountId ?? 'local-default';
  }

  private readonly accountId: string;

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
    const selectedArtifacts = this.resolveSelectedArtifacts(input);
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
          requiredCapabilities: input.subtask.requiredCapabilities,
          acceptance: input.subtask.acceptance,
          ...input.currentSubtaskOverride,
        },
        incomingHandoffs,
        outgoingHandoffRequirements,
        selectedEvidence,
        selectedArtifacts,
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
    const injected = new Set(task.injectedPreferences);
    for (const preference of this.preferenceRepo.findByStatus('confirmed')) {
      if (!injected.has(preference.content) && !preference.sourceTasks.includes(task.id)) continue;
      this.evidenceRepo.upsert({
        id: createEvidenceId('preference', preference.id),
        taskId: task.id,
        kind: 'preference',
        sourceId: preference.id,
        title: `Confirmed preference ${preference.id}`,
        content: preference.content,
        createdAt: preference.createdAt,
      });
    }
  }

  private resolveSelectedEvidence(input: {
    task: Task;
    subtask: Subtask;
    sessionId: string;
  }): SelectedExecutionEvidence[] {
    const refs = [...input.subtask.contextRefs]
      .filter((ref): ref is Exclude<ContextRef, { kind: 'artifact' }> => ref.kind !== 'artifact')
      .sort((left, right) => contextRefKey(left).localeCompare(contextRefKey(right)));
    const perRefBudget = Math.min(4_000, refs.length > 0 ? Math.floor(24_000 / refs.length) : 4_000);
    return refs.map(ref => this.resolveEvidenceRef(ref, input.task, input.sessionId, perRefBudget));
  }

  private resolveSelectedArtifacts(input: {
    task: Task;
    subtask: Subtask;
    inputFilesPath?: string;
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
      if (!isAbsolute(artifact.publishedPath)) {
        throw new Error(`artifact_context_source_invalid: ${ref.artifactId}`);
      }
      const sourceInfo = lstatSync(artifact.publishedPath, { throwIfNoEntry: false });
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error(`artifact_context_source_invalid: ${ref.artifactId}`);
      }
      const bytes = readFileSync(artifact.publishedPath);
      const actualHash = hashContent(bytes);
      if (actualHash !== artifact.contentHash) {
        throw new Error(`artifact_context_content_hash_mismatch: ${ref.artifactId}`);
      }
      const relativeInputPath = safeInputArtifactName(artifact.displayName, index);
      if (input.inputFilesPath) {
        mkdirSync(input.inputFilesPath, { recursive: true });
        materializeArtifactFile(
          artifact.publishedPath,
          join(input.inputFilesPath, relativeInputPath),
          actualHash,
        );
      }
      return {
        ref,
        artifactId: artifact.artifactId,
        displayName: artifact.displayName,
        relativeInputPath,
        mediaType: artifact.mediaType,
        contentHash: actualHash,
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
    } else if (ref.kind === 'preference') {
      const preference = this.preferenceRepo.findById(ref.preferenceId);
      if (!preference || preference.status !== 'confirmed') throw new Error(`preference_not_authorized: ${ref.preferenceId}`);
      evidenceId = createEvidenceId('preference', preference.id);
      title = `Confirmed preference ${preference.id}`;
      content = preference.content;
      this.evidenceRepo.upsert({ id: evidenceId, taskId: task.id, kind: 'preference', sourceId: preference.id, title, content });
    } else if (ref.kind === 'task_evidence') {
      const row = this.evidenceRepo.findForTask(task.id, ref.evidenceId);
      if (!row || row.kind !== 'task_evidence') throw new Error(`task_evidence_not_authorized: ${ref.evidenceId}`);
      evidenceId = row.id;
      title = row.title;
      content = row.content;
    } else if (ref.kind === 'interaction') {
      evidenceId = createEvidenceId(`${ref.side}_interaction`, ref.interactionId);
      const materialized = this.evidenceRepo.findForTask(task.id, evidenceId);
      if (materialized) {
        title = materialized.title;
        content = materialized.content;
        exactOnly = ref.side === 'assistant';
      } else {
      const row = this.db.prepare(`
        SELECT id, task_id, session_id, user_input, system_output, created_at
        FROM interactions WHERE id = ?
      `).get(ref.interactionId) as {
        id: string;
        task_id: string | null;
        session_id: string | null;
        user_input: string;
        system_output: string;
        created_at: string;
      } | undefined;
      if (!row || row.task_id !== task.id || row.session_id !== sessionId) {
        throw new Error(`interaction_not_authorized: ${ref.interactionId}`);
      }
      evidenceId = createEvidenceId(`${ref.side}_interaction`, row.id);
      title = `${ref.side} interaction ${row.id}`;
      content = ref.side === 'user' ? row.user_input : row.system_output;
      exactOnly = ref.side === 'assistant';
      this.evidenceRepo.upsert({
        id: evidenceId,
        taskId: task.id,
        kind: ref.side === 'assistant' ? 'assistant_ref' : 'user_input',
        sourceId: row.id,
        title,
        content,
        exactOnly,
        createdAt: row.created_at,
      });
      }
    } else {
      throw new Error(`context_ref_not_supported: ${ref.kind}`);
    }
    const truncated = content.length > budget;
    const preview = truncated
      ? `${content.slice(0, Math.max(0, budget - 48))}\n[TRUNCATED: use evidence get for remaining content]`
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

function materializeArtifactFile(
  sourcePath: string,
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
  copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
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
