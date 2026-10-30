import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationExecutionBinding, ConversationGitWorktree, WorkspaceGitRoot, WorkspaceMergeFile, WorkspaceMergeJob, WorkspaceMergeState, WorkspaceMergeSummary, WorkspaceGitPort } from '../workspace/workspace-git-contracts.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();

/** Account-scoped durable facts. Mutations use short SQLite transactions, never Git I/O. */
export class WorkspaceGitRepo implements WorkspaceGitPort {
  constructor(readonly db: Database.Database) {}
  sourceForTask(taskId:string):{workspaceId:string;commit:string}|null {
    const row=this.db.prepare(`SELECT b.workspace_id,COALESCE(j.merged_commit,c.result_commit,b.task_base_commit) AS source_commit
      FROM conversation_execution_bindings b LEFT JOIN task_workspace_changes c ON c.task_id=b.task_id AND c.generation_id=b.generation_id
      LEFT JOIN workspace_merge_jobs j ON j.change_id=c.change_id AND j.state='delivered'
      WHERE b.task_id=? ORDER BY b.created_at DESC,c.created_at DESC LIMIT 1`).get(taskId) as Row|undefined;
    return row?{workspaceId:row.workspace_id,commit:row.source_commit}:null;
  }
  serviceWorktree(workspaceId:string,serviceId:string,sourceCommit:string):import('../workspace/workspace-git-contracts.js').ServiceGitWorktree|null {
    const r=this.db.prepare('SELECT * FROM service_git_worktrees WHERE workspace_id=? AND service_id=? AND source_commit=?').get(workspaceId,serviceId,sourceCommit) as Row|undefined;
    return r?{serviceWorktreeId:r.service_worktree_id,workspaceId:r.workspace_id,serviceId:r.service_id,sourceTaskId:r.source_task_id,sourceCommit:r.source_commit,projectPath:r.project_path,rootPath:r.root_path,state:r.state,processToken:r.process_token,runtimeDirty:!!r.runtime_dirty}:null;
  }
  saveServiceWorktree(r:import('../workspace/workspace-git-contracts.js').ServiceGitWorktree):void {
    this.db.prepare(`INSERT INTO service_git_worktrees(service_worktree_id,workspace_id,service_id,source_task_id,source_commit,project_path,root_path,state,process_token,runtime_dirty,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service_worktree_id) DO UPDATE SET state=excluded.state,process_token=excluded.process_token,runtime_dirty=excluded.runtime_dirty,updated_at=excluded.updated_at`)
      .run(r.serviceWorktreeId,r.workspaceId,r.serviceId,r.sourceTaskId,r.sourceCommit,r.projectPath,r.rootPath,r.state,r.processToken,r.runtimeDirty?1:0,now(),now());
  }
  unfinishedOperations(workspaceId:string):import('../workspace/workspace-git-contracts.js').WorkspaceGitOperation[] {
    return (this.db.prepare("SELECT * FROM workspace_git_operations WHERE workspace_id=? AND state<>'applied' ORDER BY started_at,operation_id").all(workspaceId) as Row[])
      .map(r=>({operationId:r.operation_id,workspaceId:r.workspace_id,kind:r.kind,state:r.state,expectedRef:r.expected_ref,targetCommit:r.target_commit,payload:JSON.parse(r.payload_json)}));
  }
  plannerObservations(workspaceId:string):Array<{operationId:string;conversationId:string;pid:number|null;token:string;state:string}> {
    return (this.db.prepare("SELECT operation_id,conversation_id,owner_process,state,payload_json FROM workspace_git_operations WHERE workspace_id=? AND kind='planner_observation' AND state<>'applied'").all(workspaceId) as Row[])
      .map(row => { const payload=JSON.parse(row.payload_json) as Record<string,unknown>; return {
        operationId:row.operation_id, conversationId:String(payload.conversationId ?? row.conversation_id ?? ''),
        pid:typeof payload.pid==='number'?payload.pid:null, token:String(payload.token ?? ''), state:row.state,
      }; });
  }
  root(workspaceId: string): WorkspaceGitRoot | null {
    const row = this.db.prepare('SELECT * FROM workspace_git_roots WHERE workspace_id=?').get(workspaceId) as Row | undefined;
    return row ? { workspaceId: row.workspace_id, accountId: row.account_id, userRoot: row.canonical_path,
      repositoryPath: row.repository_path, integrationPath: row.integration_path, state: row.state,
      mainCommit: row.main_commit, deliveredCommit: row.delivered_commit } : null;
  }
  roots(): WorkspaceGitRoot[] { return (this.db.prepare('SELECT workspace_id FROM workspace_git_roots').all() as Row[]).map(row => this.root(row.workspace_id)!); }
  saveRoot(root: WorkspaceGitRoot): void {
    this.db.prepare(`INSERT INTO workspace_git_roots(workspace_id,account_id,canonical_path,repository_path,integration_path,state,main_commit,delivered_commit,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET state=excluded.state, main_commit=excluded.main_commit,
      delivered_commit=excluded.delivered_commit,row_version=row_version+1,updated_at=excluded.updated_at`).run(
      root.workspaceId, root.accountId, root.userRoot, root.repositoryPath, root.integrationPath, root.state, root.mainCommit || null, root.deliveredCommit || null, now(), now());
  }
  failRoot(workspaceId: string, error: string): void { this.db.prepare("UPDATE workspace_git_roots SET state='failed',last_error=?,updated_at=? WHERE workspace_id=?").run(error, now(), workspaceId); }
  conversation(conversationId: string): ConversationGitWorktree | null {
    const row = this.db.prepare("SELECT * FROM conversation_git_worktrees WHERE conversation_id=? AND state <> 'cleaned'").get(conversationId) as Row | undefined;
    return row ? { ...this.root(row.workspace_id)!, worktreeId: row.worktree_id, conversationId, incarnation: row.incarnation,
      branch: row.branch, rootPath: row.root_path, baseCommit: row.base_commit, headCommit: row.head_commit } : null;
  }
  saveConversation(w: ConversationGitWorktree): ConversationGitWorktree {
    this.db.prepare(`INSERT INTO conversation_git_worktrees(worktree_id,workspace_id,conversation_id,incarnation,branch,root_path,base_commit,head_commit,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'idle',?,?) ON CONFLICT(worktree_id) DO UPDATE SET base_commit=excluded.base_commit,head_commit=excluded.head_commit,updated_at=excluded.updated_at`)
      .run(w.worktreeId,w.workspaceId,w.conversationId,w.incarnation,w.branch,w.rootPath,w.baseCommit,w.headCommit,now(),now());
    return this.conversation(w.conversationId)!;
  }
  claimPlanner(conversationId: string, token: string): boolean {
    return this.db.prepare(`UPDATE conversation_git_worktrees SET owner_token=?,updated_at=?
      WHERE conversation_id=? AND owner_token IS NULL AND state NOT IN ('cleaning','cleaned','failed')`)
      .run(token,now(),conversationId).changes===1;
  }
  claimConversation(conversationId: string, taskId: string, token: string): boolean {
    return this.db.prepare(`UPDATE conversation_git_worktrees SET state='executing',owner_task_id=?,owner_token=?,updated_at=?
      WHERE conversation_id=? AND state IN ('idle','executing','awaiting_delivery') AND (owner_token IS NULL OR owner_token=?)
      AND (owner_task_id IS NULL OR owner_task_id=?)
      AND NOT EXISTS (SELECT 1 FROM task_workspace_changes c WHERE c.conversation_id=conversation_git_worktrees.conversation_id
        AND c.task_id<>? AND c.state NOT IN ('delivered','abandoned'))`).run(taskId,token,now(),conversationId,token,taskId,taskId).changes === 1;
  }
  releaseConversation(conversationId: string, token: string): void {
    this.db.prepare("UPDATE conversation_git_worktrees SET state=CASE WHEN state='executing' THEN 'idle' ELSE state END,owner_task_id=NULL,owner_token=NULL,updated_at=? WHERE conversation_id=? AND owner_token=?").run(now(),conversationId,token);
  }
  binding(taskId: string, generationId: string): ConversationExecutionBinding | null {
    const row = this.db.prepare('SELECT * FROM conversation_execution_bindings WHERE task_id=? AND generation_id=?').get(taskId,generationId) as Row | undefined;
    return row ? { bindingVersion: 'conversation-git-v1', taskId,generationId,workspaceId:row.workspace_id,conversationId:row.conversation_id,
      worktreeId:row.worktree_id,incarnation:row.incarnation,userRoot:row.user_root,executionRoot:row.execution_root,
      taskBaseCommit:row.task_base_commit,bindingFingerprint:row.binding_fingerprint,createdAt:row.created_at } : null;
  }
  bind(binding: ConversationExecutionBinding): ConversationExecutionBinding {
    this.db.prepare(`INSERT INTO conversation_execution_bindings(task_id,generation_id,workspace_id,conversation_id,worktree_id,incarnation,user_root,execution_root,task_base_commit,binding_fingerprint,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,generation_id) DO NOTHING`).run(binding.taskId,binding.generationId,binding.workspaceId,binding.conversationId,binding.worktreeId,binding.incarnation,
      binding.userRoot,binding.executionRoot,binding.taskBaseCommit,binding.bindingFingerprint,binding.createdAt);
    return this.binding(binding.taskId,binding.generationId)!;
  }
  latestBinding(conversationId: string): ConversationExecutionBinding | null {
    const row = this.db.prepare('SELECT task_id,generation_id FROM conversation_execution_bindings WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(conversationId) as Row | undefined;
    return row ? this.binding(row.task_id, row.generation_id) : null;
  }
  change(binding: ConversationExecutionBinding, resultCommit: string, held = false, proposedId?: string): string {
    const existing = this.db.prepare('SELECT change_id FROM task_workspace_changes WHERE task_id=? AND generation_id=? AND result_commit=?').get(binding.taskId,binding.generationId,resultCommit) as Row | undefined;
    if (existing) return existing.change_id;
    const id = proposedId ?? `change_${randomUUID()}`;
    this.db.prepare(`INSERT INTO task_workspace_changes(change_id,task_id,generation_id,workspace_id,conversation_id,worktree_id,base_commit,result_commit,state,delivery_policy,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,binding.taskId,binding.generationId,binding.workspaceId,binding.conversationId,binding.worktreeId,binding.taskBaseCommit,resultCommit,held?'held':'sealed',held?'hold':'publish',now(),now());
    return id;
  }
  enqueue(changeId: string, requestId: string): WorkspaceMergeJob {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM workspace_merge_jobs WHERE change_id=? OR request_id=?').get(changeId,requestId) as Row | undefined;
      if (existing) {
        if (existing.change_id !== changeId) throw new Error('merge_request_identity_mismatch');
        return fromJob(existing);
      }
      const change = this.db.prepare('SELECT * FROM task_workspace_changes WHERE change_id=?').get(changeId) as Row | undefined;
      if (!change) throw new Error('workspace_change_not_found');
      const root = this.db.prepare('SELECT next_sequence FROM workspace_git_roots WHERE workspace_id=?').get(change.workspace_id) as Row;
      const id=`merge_${randomUUID()}`;
      this.db.prepare('UPDATE workspace_git_roots SET next_sequence=next_sequence+1 WHERE workspace_id=?').run(change.workspace_id);
      this.db.prepare(`INSERT INTO workspace_merge_jobs(job_id,change_id,request_id,task_id,workspace_id,conversation_id,source_commit,sequence,state,operation_id,queued_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?)`).run(id,changeId,requestId,change.task_id,change.workspace_id,change.conversation_id,change.result_commit,root.next_sequence,`op_${randomUUID()}`,now(),now(),now());
      this.db.prepare("UPDATE task_workspace_changes SET state='queued',updated_at=? WHERE change_id=?").run(now(),changeId);
      return this.job(id)!;
    }).immediate();
  }
  job(jobId: string): WorkspaceMergeJob | null {
    const row=this.db.prepare('SELECT * FROM workspace_merge_jobs WHERE job_id=?').get(jobId) as Row | undefined; return row?fromJob(row):null;
  }
  head(workspaceId: string): WorkspaceMergeJob | null {
    const row=this.db.prepare("SELECT * FROM workspace_merge_jobs WHERE workspace_id=? AND state NOT IN ('delivered','cancelled') ORDER BY sequence LIMIT 1").get(workspaceId) as Row | undefined; return row?fromJob(row):null;
  }
  queue(workspaceId: string, afterSequence = 0): WorkspaceMergeJob[] { return (this.db.prepare('SELECT * FROM workspace_merge_jobs WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(workspaceId,afterSequence) as Row[]).map(fromJob); }
  updateJob(jobId: string, state: WorkspaceMergeState, patch: { expectedMain?: string; externalCommit?: string; mergedCommit?: string; error?: string | null; conflictVersion?: number } = {}): WorkspaceMergeJob {
    const old=this.job(jobId); if(!old) throw new Error('merge_job_not_found');
    const next={...old,...patch};
    const result=this.db.prepare(`UPDATE workspace_merge_jobs SET state=?,expected_main=?,external_commit=?,merged_commit=?,error=?,conflict_version=?,row_version=row_version+1,updated_at=?,
      merge_started_at=CASE WHEN ?='merging' THEN COALESCE(merge_started_at,?) ELSE merge_started_at END,
      delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END WHERE job_id=? AND row_version=?`).run(state,next.expectedMain,next.externalCommit,next.mergedCommit,next.error,next.conflictVersion,now(),state,now(),state,now(),jobId,old.rowVersion);
    if(result.changes!==1) throw new Error('stale_merge_job');
    if(state==='cancelled') this.db.prepare("UPDATE task_workspace_changes SET state='held',updated_at=? WHERE change_id=?").run(now(),old.changeId);
    if(state==='delivered') {
      this.db.prepare("UPDATE task_workspace_changes SET state='delivered',updated_at=? WHERE change_id=?").run(now(),old.changeId);
      this.markHeldDelivered(old.conversationId, old.sourceCommit);
    }
    return this.job(jobId)!;
  }
  saveFiles(files: WorkspaceMergeFile[]): void {
    this.db.transaction(() => {
      const insert=this.db.prepare(`INSERT INTO workspace_merge_files(job_id,ordinal,relative_path,operation,before_kind,before_blob,before_mode,after_kind,after_blob,after_mode,before_sha256,after_sha256,state,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,ordinal) DO NOTHING`);
      for(const f of files) insert.run(f.jobId,f.ordinal,f.relativePath,!f.before?'add':!f.after?'delete':'modify',f.before?.kind??null,f.before?.oid??null,f.before?.mode??null,f.after?.kind??null,f.after?.oid??null,f.after?.mode??null,f.beforeSha256,f.afterSha256,f.state,f.lastError);
    })();
  }
  files(jobId: string): WorkspaceMergeFile[] {
    return (this.db.prepare('SELECT * FROM workspace_merge_files WHERE job_id=? ORDER BY ordinal').all(jobId) as Row[]).map(r=>({jobId,ordinal:r.ordinal,relativePath:r.relative_path,
      before:r.before_blob?{path:r.relative_path,oid:r.before_blob,mode:r.before_mode,kind:r.before_kind}:null,
      after:r.after_blob?{path:r.relative_path,oid:r.after_blob,mode:r.after_mode,kind:r.after_kind}:null,beforeSha256:r.before_sha256,afterSha256:r.after_sha256,state:r.state,lastError:r.last_error}));
  }
  fileState(jobId:string,ordinal:number,state:WorkspaceMergeFile['state'],error:string|null=null):void {
    this.db.prepare('UPDATE workspace_merge_files SET state=?,last_error=?,backup_blob=COALESCE(backup_blob,before_blob) WHERE job_id=? AND ordinal=?').run(state,error,jobId,ordinal);
  }
  summary(taskId:string,generationId?:string):WorkspaceMergeSummary|null {
    const row=this.db.prepare(`SELECT j.* FROM workspace_merge_jobs j JOIN task_workspace_changes c ON c.change_id=j.change_id WHERE j.task_id=? AND (? IS NULL OR c.generation_id=?) ORDER BY j.sequence DESC LIMIT 1`).get(taskId,generationId??null,generationId??null) as Row|undefined;
    if(!row)return null;
    const job=fromJob(row); const files=this.files(job.jobId);
    const ahead=this.db.prepare("SELECT count(*) AS count FROM workspace_merge_jobs WHERE workspace_id=? AND sequence<? AND state NOT IN ('delivered','cancelled')").get(job.workspaceId,job.sequence) as Row;
    return {rowVersion:job.rowVersion,jobId:job.jobId,state:job.state,sequence:job.sequence,aheadCount:ahead.count,conflictVersion:job.conflictVersion,completedFiles:files.filter(f=>f.state==='applied').length,totalFiles:files.length,error:job.error};
  }
  nextIncarnation(conversationId:string):number {
    return (this.db.prepare('SELECT COALESCE(MAX(incarnation),0)+1 AS value FROM conversation_git_worktrees WHERE conversation_id=?').get(conversationId) as {value:number}).value;
  }
  conversationState(worktreeId:string):{state:string;ownerToken:string|null;ownerTaskId:string|null;cleanupRequestedAt:string|null} {
    const r=this.db.prepare('SELECT * FROM conversation_git_worktrees WHERE worktree_id=?').get(worktreeId) as Row;
    return {state:r.state,ownerToken:r.owner_token,ownerTaskId:r.owner_task_id,cleanupRequestedAt:r.cleanup_requested_at};
  }
  setConversationState(worktreeId:string,state:string):void {
    this.db.prepare('UPDATE conversation_git_worktrees SET state=?,updated_at=? WHERE worktree_id=?').run(state,now(),worktreeId);
  }
  requestCleanup(worktreeId:string):void {
    this.db.prepare('UPDATE conversation_git_worktrees SET cleanup_requested_at=? WHERE worktree_id=?').run(now(),worktreeId);
  }
  cleanupBlocked(worktreeId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM task_workspace_changes WHERE worktree_id=? AND state NOT IN ('delivered','abandoned') LIMIT 1").get(worktreeId)
      || !!this.db.prepare("SELECT 1 FROM conversation_execution_bindings b JOIN tasks t ON t.id=b.task_id WHERE b.worktree_id=? AND t.status IN ('queued','running','needs_action') LIMIT 1").get(worktreeId);
  }
  conversations(workspaceId:string):ConversationGitWorktree[] {
    return (this.db.prepare("SELECT conversation_id FROM conversation_git_worktrees WHERE workspace_id=? AND state<>'cleaned'").all(workspaceId) as Row[]).map(r=>this.conversation(r.conversation_id)!);
  }
  recordAttemptCommit(attemptId:string,worktree:ConversationGitWorktree,after:string):void {
    this.db.prepare('UPDATE executor_attempt_runtime SET worktree_id=?,worktree_incarnation=?,before_commit=?,after_commit=? WHERE attempt_id=?').run(worktree.worktreeId,worktree.incarnation,worktree.headCommit,after,attemptId);
  }
  stoppedOwners(workspaceId:string):Array<{conversationId:string;token:string;attemptId:string;taskId:string;generationId:string}> {
    return (this.db.prepare(`SELECT w.conversation_id,w.owner_token,a.attempt_id,a.task_id,a.generation_id
      FROM conversation_git_worktrees w JOIN attempt_sandboxes a
      ON a.task_id=w.owner_task_id AND a.lease_token=w.owner_token
      WHERE w.workspace_id=? AND w.owner_token IS NOT NULL AND a.cleanup_status='removed'
      AND a.status='removed'`).all(workspaceId) as Row[]).map(r=>({conversationId:r.conversation_id,
        token:r.owner_token,attemptId:r.attempt_id,taskId:r.task_id,generationId:r.generation_id}));
  }
  operationRecord(operationId:string):{state:string;payload:Record<string,unknown>;expectedRef:string|null;targetCommit:string|null}|null {
    const r=this.db.prepare('SELECT * FROM workspace_git_operations WHERE operation_id=?').get(operationId) as Row|undefined;
    return r?{state:r.state,payload:JSON.parse(r.payload_json),expectedRef:r.expected_ref,targetCommit:r.target_commit}:null;
  }
  reviseManifest(jobId:string,external:string,merged:string):void {
    this.db.transaction(()=>{
      this.replaceFiles(jobId,[]);
      this.updateJob(jobId,'writing',{externalCommit:external,mergedCommit:merged,error:null});
    })();
  }
  replaceFiles(jobId:string,files:WorkspaceMergeFile[]):void {
    this.db.transaction(()=>{this.db.prepare('DELETE FROM workspace_merge_files WHERE job_id=?').run(jobId);this.saveFiles(files);})();
  }
  hasUndeliveredChanges(conversationId:string,exceptTaskId?:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM task_workspace_changes WHERE conversation_id=? AND state NOT IN ('delivered','abandoned','held') AND (? IS NULL OR task_id<>?) LIMIT 1")
      .get(conversationId,exceptTaskId??null,exceptTaskId??null);
  }
  heldBaseCommit(conversationId:string):string|null {
    const row=this.db.prepare("SELECT base_commit FROM task_workspace_changes WHERE conversation_id=? AND state='held' ORDER BY created_at LIMIT 1").get(conversationId) as Row|undefined;
    return row?.base_commit ?? null;
  }
  markHeldDelivered(conversationId:string,throughCommit:string):void {
    this.db.prepare("UPDATE task_workspace_changes SET state='delivered',updated_at=? WHERE conversation_id=? AND state='held' AND result_commit<>?").run(now(),conversationId,throughCommit);
  }
  hasHeldChange(taskId:string,generationId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM task_workspace_changes WHERE task_id=? AND generation_id=? AND state='held'").get(taskId,generationId);
  }
  operation(input:{operationId:string;workspaceId:string;kind:string;expectedRef?:string;targetCommit?:string;payload?:object}):void {
    const existing = this.db.prepare('SELECT * FROM workspace_git_operations WHERE operation_id=?').get(input.operationId) as Row | undefined;
    const payload = JSON.stringify(input.payload ?? {});
    if (existing) {
      if (existing.workspace_id !== input.workspaceId || existing.kind !== input.kind
        || existing.expected_ref !== (input.expectedRef ?? null) || existing.target_commit !== (input.targetCommit ?? null)
        || existing.payload_json !== payload) throw new Error('git_operation_identity_mismatch');
      return;
    }
    this.db.prepare(`INSERT INTO workspace_git_operations(operation_id,idempotency_key,workspace_id,kind,state,expected_ref,target_commit,payload_json,started_at,updated_at)
      VALUES(?,?,?,?,'prepared',?,?,?,?,?)`).run(input.operationId,input.operationId,input.workspaceId,input.kind,input.expectedRef??null,input.targetCommit??null,payload,now(),now());
  }
  operationState(operationId:string,state:'applying'|'applied'|'needs_recovery'):void {
    this.db.prepare('UPDATE workspace_git_operations SET state=?,updated_at=?,finished_at=? WHERE operation_id=?').run(state,now(),state==='applied'?now():null,operationId);
  }
}
function fromJob(r:Row):WorkspaceMergeJob { return {jobId:r.job_id,changeId:r.change_id,requestId:r.request_id,taskId:r.task_id,workspaceId:r.workspace_id,conversationId:r.conversation_id,
  sourceCommit:r.source_commit,sequence:r.sequence,state:r.state,expectedMain:r.expected_main,externalCommit:r.external_commit,mergedCommit:r.merged_commit,conflictVersion:r.conflict_version,rowVersion:r.row_version,
  operationId:r.operation_id,error:r.error,cancelRequested:!!r.cancel_requested,createdAt:r.created_at,updatedAt:r.updated_at}; }
