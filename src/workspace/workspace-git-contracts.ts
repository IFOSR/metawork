/** Shared identity contracts; Runtime owns filesystem operations, Storage owns facts. */
export type WorkspaceGitState = 'initializing' | 'ready' | 'recovering' | 'failed';
export interface WorkspaceGitRoot {
  workspaceId: string;
  accountId: string;
  userRoot: string;
  repositoryPath: string;
  integrationPath: string;
  mainCommit: string;
  deliveredCommit: string;
  state: WorkspaceGitState;
}
export interface ConversationGitWorktree extends WorkspaceGitRoot {
  conversationId: string;
  worktreeId: string;
  incarnation: number;
  branch: string;
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}
export interface GitTreeEntry {
  path: string;
  oid: string;
  mode: string;
  kind: 'file' | 'symlink';
}
export interface ConversationExecutionBinding {
  bindingVersion: 'conversation-git-v1';
  taskId: string;
  generationId: string;
  workspaceId: string;
  conversationId: string;
  worktreeId: string;
  incarnation: number;
  userRoot: string;
  executionRoot: string;
  taskBaseCommit: string;
  bindingFingerprint: string;
  createdAt: string;
}
export type WorkspaceMergeState = 'queued' | 'preparing' | 'merging' | 'conflicted' | 'writing' | 'recovering' | 'delivered' | 'cancelled';
export interface WorkspaceMergeJob {
  jobId: string;
  changeId: string;
  requestId: string;
  taskId: string;
  workspaceId: string;
  conversationId: string;
  sourceCommit: string;
  sequence: number;
  state: WorkspaceMergeState;
  expectedMain: string | null;
  externalCommit: string | null;
  mergedCommit: string | null;
  conflictVersion: number;
  rowVersion: number;
  operationId: string;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceMergeFile {
  jobId: string;
  ordinal: number;
  relativePath: string;
  before: GitTreeEntry | null;
  after: GitTreeEntry | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  state: 'pending' | 'prepared' | 'applied' | 'conflicted';
  lastError: string | null;
}
export interface WorkspaceConflictVersions {
  conflictVersion: number;
  path: string;
  versions: Array<{side: 'base' | 'main' | 'session'; commit: string; exists: boolean;
    kind: 'file' | 'symlink' | null; byteLength: number; offset: number; nextOffset: number | null;
    contentBase64: string; text: string | null}>;
}
export interface WorkspaceMergeSummary {
  rowVersion: number; jobId: string; state: WorkspaceMergeState; sequence: number; aheadCount: number;
  conflictVersion: number; completedFiles: number; totalFiles: number; error: string | null;
}

export interface ServiceGitWorktree {
  serviceWorktreeId:string; workspaceId:string; serviceId:string; sourceTaskId:string;
  sourceCommit:string; projectPath:string; rootPath:string;
  state:'preparing'|'ready'|'running'|'stopped'|'retained'|'cleaning'|'cleaned'|'failed';
  processToken:string|null; runtimeDirty:boolean;
}
export interface WorkspaceGitOperation {
  operationId: string; workspaceId: string; kind: string; state: string;
  expectedRef: string|null; targetCommit: string|null; payload: Record<string,unknown>;
}

/** Persistence port owned by Workspace/Execution; implementations live in Storage. */
export interface WorkspaceGitPort {
  serviceWorktree(workspaceId:string,serviceId:string,sourceCommit:string):ServiceGitWorktree|null;
  saveServiceWorktree(record:ServiceGitWorktree):void;
  sourceForTask(taskId:string):{workspaceId:string;commit:string}|null;
  unfinishedOperations(workspaceId:string):WorkspaceGitOperation[];
  plannerObservations(workspaceId:string):Array<{operationId:string;conversationId:string;pid:number|null;token:string;state:string}>;
  root(workspaceId: string): WorkspaceGitRoot | null;
  roots(): WorkspaceGitRoot[];
  saveRoot(root: WorkspaceGitRoot): void;
  failRoot(workspaceId: string, error: string): void;
  conversation(conversationId: string): ConversationGitWorktree | null;
  saveConversation(w: ConversationGitWorktree): ConversationGitWorktree;
  claimPlanner(conversationId: string, token: string): boolean;
  claimConversation(conversationId: string, taskId: string, token: string): boolean;
  releaseConversation(conversationId: string, token: string): void;
  binding(taskId: string, generationId: string): ConversationExecutionBinding | null;
  latestBinding(conversationId: string): ConversationExecutionBinding | null;
  bind(binding: ConversationExecutionBinding): ConversationExecutionBinding;
  change(binding: ConversationExecutionBinding, resultCommit: string, held?: boolean, proposedId?: string): string;
  enqueue(changeId: string, requestId: string): WorkspaceMergeJob;
  job(jobId: string): WorkspaceMergeJob | null;
  head(workspaceId: string): WorkspaceMergeJob | null;
  queue(workspaceId: string, afterSequence?: number): WorkspaceMergeJob[];
  updateJob(jobId: string, state: WorkspaceMergeState, patch?: { expectedMain?: string; externalCommit?: string; mergedCommit?: string; error?: string | null; conflictVersion?: number }): WorkspaceMergeJob;
  saveFiles(files: WorkspaceMergeFile[]): void;
  files(jobId: string): WorkspaceMergeFile[];
  fileState(jobId:string,ordinal:number,state:WorkspaceMergeFile['state'],error?:string|null):void;
  summary(taskId:string,generationId?:string):WorkspaceMergeSummary|null;
  nextIncarnation(conversationId:string):number;
  conversationState(worktreeId:string):{state:string;ownerToken:string|null;ownerTaskId:string|null;cleanupRequestedAt:string|null};
  setConversationState(worktreeId:string,state:string):void;
  requestCleanup(worktreeId:string):void;
  cleanupBlocked(worktreeId:string):boolean;
  conversations(workspaceId:string):ConversationGitWorktree[];
  recordAttemptCommit(attemptId:string,worktree:ConversationGitWorktree,after:string):void;
  stoppedOwners(workspaceId:string):Array<{conversationId:string;token:string;attemptId:string;taskId:string;generationId:string}>;
  operationRecord(operationId:string):{state:string;payload:Record<string,unknown>;expectedRef:string|null;targetCommit:string|null}|null;
  reviseManifest(jobId:string,external:string,merged:string):void;
  replaceFiles(jobId:string,files:WorkspaceMergeFile[]):void;
  hasUndeliveredChanges(conversationId:string,exceptTaskId?:string):boolean;
  heldBaseCommit(conversationId:string):string|null;
  markHeldDelivered(conversationId:string,throughCommit:string):void;
  hasHeldChange(taskId:string,generationId:string):boolean;
  operation(input:{operationId:string;workspaceId:string;kind:string;expectedRef?:string;targetCommit?:string;payload?:object}):void;
  operationState(operationId:string,state:'applying'|'applied'|'needs_recovery'):void;
}
