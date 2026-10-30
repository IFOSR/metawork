import { createHash } from 'node:crypto';
import type { GitTreeEntry } from '../workspace/workspace-git-contracts.js';
import type { WorkspaceGitRoot, WorkspaceMergeJob } from '../workspace/workspace-git-contracts.js';
import type { WorkspaceGitPort } from '../workspace/workspace-git-contracts.js';
import { assertGitPath, WorkspaceGitService } from './workspace-git-service.js';
import { withWorkspaceGitLock } from './workspace-git-lock.js';
import { WorkspaceWritebackConflict, WorkspaceWritebackService } from '../delivery/workspace-writeback-service.js';

export interface WorkspaceConflictAction { path:string;action:'keep_main'|'take_session'|'save_as'|'resolved_file';newPath?:string;content?:Buffer; }

/** One FIFO per Workspace; conflicts block delivery, never other sessions' execution. */
export class WorkspaceMergeWorker {
  private readonly writeback:WorkspaceWritebackService;
  constructor(readonly git:WorkspaceGitService,readonly repo:WorkspaceGitPort,private onChanged?:(job:WorkspaceMergeJob)=>Promise<void>|void){
    this.writeback=new WorkspaceWritebackService(git,repo);
  }
  setObserver(observer:(job:WorkspaceMergeJob)=>Promise<void>|void):void { this.onChanged=observer; }
  async retry(jobId:string,expectedRowVersion:number):Promise<void> {
    const job=this.repo.job(jobId);if(!job)throw new Error('merge_job_not_found');
    if(job.rowVersion!==expectedRowVersion)throw new Error('stale_merge_job');
    if(job.state==='conflicted')throw new Error('merge_conflict_requires_resolution');
    await this.recover(job.workspaceId);
  }
  async recover(workspaceId:string,startup=false):Promise<void> {
    const root=this.repo.root(workspaceId);if(!root||(!startup&&root.state!=='ready'))return;
    await withWorkspaceGitLock(root.repositoryPath,'integration',async verify=>{
      for(const op of this.repo.unfinishedOperations(workspaceId)) {
        const root=this.repo.root(workspaceId)!;
        const jobId=op.payload.jobId;
        if(typeof jobId!=='string')continue;
        const job=this.repo.job(jobId);if(!job)continue;
        if(op.kind==='resolve_index') {
          if(job.state==='conflicted' && job.conflictVersion===op.payload.conflictVersion) {
            await verify();
            await this.git.updateIndex(root.repositoryPath,op.payload.changes as Array<{path:string;entry:GitTreeEntry|null}>,{GIT_INDEX_FILE:await this.git.integrationIndex(root)});
            this.repo.updateJob(jobId,(await this.conflictPaths(root)).length?'conflicted':'merging',{
              conflictVersion:job.conflictVersion+1,error:null,
            });
          }
          this.repo.operationState(op.operationId,'applied');
          if(typeof op.payload.resolveOperationId==='string')this.repo.operationState(op.payload.resolveOperationId,'applied');
        }
        if(op.kind==='writeback_revision') await this.finishRevision(root,job,op.operationId,op.expectedRef!,op.targetCommit!,String(op.payload.external),verify);
        if(op.kind==='merge_cancel') {
          await this.finishCancellation(root,job,op.operationId,op.targetCommit!,verify);
          for(const parent of this.repo.unfinishedOperations(workspaceId))if(parent.kind==='cancel_request'&&parent.payload.jobId===jobId)this.repo.operationState(parent.operationId,'applied');
        }
        if(op.kind==='cancel_request'&&this.repo.job(jobId)?.state==='cancelled')this.repo.operationState(op.operationId,'applied');
      }
    });
    await this.drain(workspaceId,startup);
  }
  async drain(workspaceId:string,startup=false):Promise<void>{
    const root=this.repo.root(workspaceId);if(!root||(!startup&&root.state!=='ready'))return;
    const changed: WorkspaceMergeJob[] = [];
    await withWorkspaceGitLock(root.repositoryPath,'integration',async verify=>{
      for(;;){
        let job=this.repo.head(workspaceId);if(!job||job.state==='conflicted')return;
        try{job=await this.process(this.repo.root(workspaceId)!,job,verify);}
        catch(error){
          const current=this.repo.job(job.jobId)!;
          job=this.repo.updateJob(job.jobId,error instanceof WorkspaceWritebackConflict?'conflicted':'recovering',{
            error:error instanceof Error?error.message:String(error),
            conflictVersion:current.conflictVersion+1,
          });
          this.repo.operationState(job.operationId,'needs_recovery');
          changed.push(job);return;
        }
        changed.push(job);
        if(job.state!=='delivered')return;
      }
    });
    // Continuations may acquire the integration lock (service repair, another drain).
    // Notify only after releasing it; durable jobs are replayed by recovery.
    for (const job of changed) await this.onChanged?.(job);
  }
  private async process(root:WorkspaceGitRoot,job:WorkspaceMergeJob,verify:()=>Promise<void>):Promise<WorkspaceMergeJob>{
    const opRef=`refs/metawork/operations/${job.operationId}`;
    if(!job.mergedCommit){
      if(job.state==='queued'||!job.externalCommit){
        job=this.repo.updateJob(job.jobId,'preparing');
        const delivered=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
        const intent=this.repo.operationRecord(job.operationId);
        const external=intent?.targetCommit ?? await this.git.capture(root.repositoryPath,root.userRoot,delivered,'Capture external Workspace edits');
        const before=intent?.expectedRef ?? delivered;
        await this.git.updateRef(root.repositoryPath,`${opRef}-external`,external);
        this.repo.operation({operationId:job.operationId,workspaceId:root.workspaceId,kind:'merge',expectedRef:before,targetCommit:external,payload:{jobId:job.jobId,sourceCommit:job.sourceCommit}});
        await verify();
        const actualMain=await this.git.ref(root.repositoryPath,'refs/heads/main');
        if(actualMain!==before&&actualMain!==external)throw new Error('unexpected_workspace_main');
        if(actualMain!==external)await this.git.updateRef(root.repositoryPath,'refs/heads/main',external,before);
        if(delivered!==external)await this.git.updateRef(root.repositoryPath,'refs/metawork/delivered',external,before);
        root={...root,mainCommit:external,deliveredCommit:external};this.repo.saveRoot(root);
        job=this.repo.updateJob(job.jobId,'merging',{expectedMain:external,externalCommit:external,error:null});
      }
      const expected=job.externalCommit!;
      const pinned=await this.git.ref(root.repositoryPath,opRef).catch(()=>null);
      if(pinned){job=this.repo.updateJob(job.jobId,'merging',{mergedCommit:pinned});}
      else if(await this.git.isAncestor(root.repositoryPath,job.sourceCommit,expected)){
        job=this.repo.updateJob(job.jobId,'merging',{mergedCommit:expected});
        await this.git.updateRef(root.repositoryPath,opRef,expected);
      }else{
        const mergeHead=await this.git.text(['-C',root.integrationPath,'rev-parse','--verify','MERGE_HEAD']).catch(()=>null);
        if(!mergeHead){
          await this.git.text(['-C',root.integrationPath,'reset','--hard',expected]);
          try{await withWorkspaceGitLock(root.repositoryPath,'metadata',async()=>{
            await this.git.prepareMergeAttributes(root.repositoryPath,[expected,job.sourceCommit]);
            await this.git.text(['-C',root.integrationPath,'merge','--no-ff','--no-commit',job.sourceCommit]);
          });}
          catch(error){
            const paths=await this.conflictPaths(root);
            if(!paths.length)throw error;
            return this.repo.updateJob(job.jobId,'conflicted',{conflictVersion:job.conflictVersion+1,error:'工作已完成，合并冲突需要选择文件版本。'});
          }
        }else if(mergeHead!==job.sourceCommit)throw new Error('merge_operation_identity_mismatch');
        if((await this.conflictPaths(root)).length)return this.repo.updateJob(job.jobId,'conflicted',{conflictVersion:job.conflictVersion+1});
        const tree=await this.git.text(['-C',root.integrationPath,'write-tree']);
        const merged=await this.git.commitTree(root.repositoryPath,tree,[expected,job.sourceCommit],`Merge ${job.taskId}`);
        await this.git.updateRef(root.repositoryPath,opRef,merged);
        job=this.repo.updateJob(job.jobId,'merging',{mergedCommit:merged});
      }
    }
    const merged=job.mergedCommit!,external=job.externalCommit!;
    const current=await this.git.ref(root.repositoryPath,'refs/heads/main');
    if(current!==external&&current!==merged)throw new Error('unexpected_main_during_merge');
    await verify();
    if(current!==merged)await this.git.updateRef(root.repositoryPath,'refs/heads/main',merged,external);
    // Keep integration checked out at the committed result and clear MERGE_HEAD.
    await this.git.text(['-C',root.integrationPath,'reset','--hard',merged]);
    this.repo.saveRoot({...root,mainCommit:merged});
    await this.writeback.manifest(root,job.jobId,external,merged);
    job=this.repo.updateJob(job.jobId,'writing',{error:null});
    this.repo.operationState(job.operationId,'applying');
    await this.writeback.apply(root,job.jobId,verify);
    await verify();
    const delivered=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
    if(delivered!==merged)await this.git.updateRef(root.repositoryPath,'refs/metawork/delivered',merged,external);
    this.repo.saveRoot({...root,mainCommit:merged,deliveredCommit:merged});
    this.repo.operationState(job.operationId,'applied');
    return this.repo.updateJob(job.jobId,'delivered',{error:null});
  }
  async conflicts(jobId:string):Promise<{job:WorkspaceMergeJob;paths:string[]}>{
    const job=this.repo.job(jobId);if(!job)throw new Error('merge_job_not_found');
    const root=this.repo.root(job.workspaceId)!;
    // The integration index belongs only to the FIFO head, never a queued job.
    if (job.state !== 'conflicted' || this.repo.head(job.workspaceId)?.jobId !== jobId) return {job, paths: []};
    return {job,paths:job.mergedCommit?this.repo.files(jobId).filter(f=>f.state==='conflicted').map(f=>f.relativePath):await this.conflictPaths(root)};
  }
  async conflictVersions(jobId: string, version: number, path: string, offset = 0): Promise<import('../workspace/workspace-git-contracts.js').WorkspaceConflictVersions> {
    assertGitPath(path);
    const found = this.repo.job(jobId); if (!found) throw new Error('merge_job_not_found');
    const root = this.repo.root(found.workspaceId)!;
    return withWorkspaceGitLock(root.repositoryPath, 'integration', async () => {
      const {job, paths} = await this.conflicts(jobId);
      if (job.conflictVersion !== version || !paths.includes(path)) throw new Error('stale_workspace_conflict');
      const main = job.mergedCommit ? await this.git.capture(root.repositoryPath, root.userRoot, job.externalCommit!, 'Observe writeback conflict') : job.externalCommit!;
      const base = await this.git.text(['--git-dir', root.repositoryPath, 'merge-base', job.externalCommit!, job.sourceCommit]);
      const versions: import('../workspace/workspace-git-contracts.js').WorkspaceConflictVersions['versions'] = [];
      for (const [side, commit] of [['base', base], ['main', main], ['session', job.sourceCommit]] as const) {
        const entry = (await this.git.entries(root.repositoryPath, commit)).find(entry => entry.path === path);
        const size = entry ? Number(await this.git.text(['--git-dir', root.repositoryPath, 'cat-file', '-s', entry.oid])) : 0;
        const bytes = entry ? await this.git.blobRange(root.repositoryPath, entry.oid, offset, 256 * 1024) : Buffer.alloc(0);
        let text: string | null = null;
        if (size <= 256 * 1024 && offset === 0 && !bytes.includes(0) && !/\.(?:pptx?|docx?|xlsx?|pdf|png|jpe?g|gif|zip)$/iu.test(path)) {
          try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { /* binary */ }
        }
        versions.push({side, commit, exists: !!entry, kind: entry?.kind ?? null, byteLength: size,
          offset, nextOffset: offset + bytes.length < size ? offset + bytes.length : null, contentBase64: bytes.toString('base64'), text});
      }
      return {conflictVersion: version, path, versions};
    });
  }
  private async conflictPaths(root:WorkspaceGitRoot):Promise<string[]>{
    return (await this.git.run(['-C',root.integrationPath,'diff','--name-only','--diff-filter=U','-z'])).toString('utf8').split('\0').filter(Boolean);
  }
  async resolve(input:{jobId:string;requestId:string;expectedConflictVersion:number;expectedRowVersion?:number;actions:WorkspaceConflictAction[]}):Promise<void>{
    const job=this.repo.job(input.jobId);if(!job)throw new Error('merge_job_not_found');
    const root=this.repo.root(job.workspaceId)!;
    const operationId=`resolve_${input.requestId}`;
    const fingerprint=createHash('sha256').update(JSON.stringify({...input,actions:input.actions.map(a=>({...a,content:a.content?.toString('base64')}))})).digest('hex');
    await withWorkspaceGitLock(root.repositoryPath,'integration',async verify=>{
      const replay=this.repo.operationRecord(operationId);
      if(replay && replay.payload.fingerprint!==fingerprint)throw new Error('merge_request_identity_mismatch');
      if(replay?.state==='applied')return;
      const current=this.repo.job(job.jobId)!;
      const indexReplay=this.repo.operationRecord(`${operationId}_index`);
      if(indexReplay) {
        if(current.state==='conflicted' && current.conflictVersion===indexReplay.payload.conflictVersion) {
          await this.git.updateIndex(root.repositoryPath,indexReplay.payload.changes as Array<{path:string;entry:GitTreeEntry|null}>,{GIT_INDEX_FILE:await this.git.integrationIndex(root)});
          this.repo.updateJob(job.jobId,(await this.conflictPaths(root)).length?'conflicted':'merging',{conflictVersion:current.conflictVersion+1,error:null});
        }
        this.repo.operationState(`${operationId}_index`,'applied');this.repo.operationState(operationId,'applied');return;
      }
      const revisionReplay=this.repo.operationRecord(`${job.operationId}_revision_${input.expectedConflictVersion}`);
      if(revisionReplay) {
        await this.finishRevision(root,current,`${job.operationId}_revision_${input.expectedConflictVersion}`,revisionReplay.expectedRef!,revisionReplay.targetCommit!,String(revisionReplay.payload.external),verify);
        this.repo.operationState(operationId,'applied');return;
      }
      if((input.expectedRowVersion!==undefined&&input.expectedRowVersion!==current.rowVersion)||current.state!=='conflicted'||current.conflictVersion!==input.expectedConflictVersion)throw new Error('stale_workspace_conflict');
      if (current.mergedCommit && await this.writeback.auditApplied(root, job.jobId)) {
        this.repo.updateJob(job.jobId, 'conflicted', {conflictVersion: current.conflictVersion + 1});
        throw new Error('stale_workspace_conflict');
      }
      const paths=(await this.conflicts(job.jobId)).paths;
      if(new Set(input.actions.map(a=>a.path)).size!==input.actions.length)throw new Error('duplicate_conflict_path');
      for(const action of input.actions){
        assertGitPath(action.path);if(!paths.includes(action.path))throw new Error('conflict_path_not_found');
        if(action.action==='save_as'){if(!action.newPath)throw new Error('save_as_path_required');assertGitPath(action.newPath);}
      }
      this.repo.operation({operationId,workspaceId:root.workspaceId,kind:'resolve',payload:{jobId:job.jobId,fingerprint,actions:input.actions.map(a=>({...a,content:a.content?.toString('base64')}))}});
      if(current.mergedCommit){
        if(paths.some(path=>!input.actions.some(action=>action.path===path)))throw new Error('all_writeback_conflicts_require_resolution');
        await this.reviseWriteback(root,current,input.actions,verify);
      }else{
        const output=await this.git.run(['-C',root.integrationPath,'ls-files','-u','-z']);
        const stages=new Map<string,Map<string,GitTreeEntry>>();
        for(const row of output.toString('utf8').split('\0').filter(Boolean)){
          const tab=row.indexOf('\t');const [mode,oid,stage]=row.slice(0,tab).split(' ');const path=row.slice(tab+1);
          const entries=stages.get(path)??new Map();entries.set(stage,{path,mode,oid,kind:mode==='120000'?'symlink':'file'});stages.set(path,entries);
        }
        const present=new Set([...(await this.git.entries(root.repositoryPath,current.externalCommit!)), ...(await this.git.entries(root.repositoryPath,current.sourceCommit))].map(e=>e.path));
        const changes:Array<{path:string;entry:GitTreeEntry|null}>=[];
        for(const action of input.actions){
          const versions=stages.get(action.path)!;
          let entry=versions.get(action.action==='keep_main'?'2':'3')??null;
          if(action.action==='resolved_file')entry=await this.resolvedEntry(root,action,versions.get('3')??versions.get('2'));
          if(action.action==='save_as'){
            if([...present,...changes.map(c=>c.path)].some(path=>collides(path,action.newPath!)))throw new Error('save_as_path_exists');
            if(!entry)throw new Error('save_as_source_missing');
            changes.push({path:action.newPath!,entry:{...entry,path:action.newPath!}});present.add(action.newPath!);
            entry=versions.get('2')??null;
          }
          changes.push({path:action.path,entry});
        }
        this.repo.operation({operationId:`${operationId}_index`,workspaceId:root.workspaceId,kind:'resolve_index',
          payload:{jobId:job.jobId,resolveOperationId:operationId,conflictVersion:current.conflictVersion,changes}});
        await verify();
        // Raw index records cannot follow an integration-worktree symlink or run a filter.
        await this.git.updateIndex(root.repositoryPath,changes,{GIT_INDEX_FILE:await this.git.integrationIndex(root)});
        if(!(await this.conflictPaths(root)).length)this.repo.updateJob(job.jobId,'merging',{error:null,conflictVersion:current.conflictVersion+1});
        else this.repo.updateJob(job.jobId,'conflicted',{conflictVersion:current.conflictVersion+1});
        this.repo.operationState(`${operationId}_index`,'applied');
      }
      this.repo.operationState(operationId,'applied');
    });
    await this.drain(job.workspaceId);
  }
  private async resolvedEntry(root:WorkspaceGitRoot,action:WorkspaceConflictAction,template?:GitTreeEntry):Promise<GitTreeEntry>{
    if(!action.content)throw new Error('resolved_content_required');
    const oid=await this.git.text(['--git-dir',root.repositoryPath,'hash-object','--no-filters','-w','--stdin'],action.content);
    return {path:action.path,oid,mode:template?.kind==='file'?template.mode:'100644',kind:'file'};
  }
  private async reviseWriteback(root:WorkspaceGitRoot,job:WorkspaceMergeJob,actions:WorkspaceConflictAction[],verify:()=>Promise<void>):Promise<void>{
    const external=await this.git.capture(root.repositoryPath,root.userRoot,job.externalCommit!,'Capture user edits during delivery');
    const actual=new Map((await this.git.entries(root.repositoryPath,external)).map(e=>[e.path,e]));
    const changes:Array<{path:string;entry:GitTreeEntry|null}>=[];
    const reserved=(await this.git.entries(root.repositoryPath,job.mergedCommit!)).map(entry=>entry.path);
    for(const file of this.repo.files(job.jobId)){
      const action=actions.find(a=>a.path===file.relativePath);
      if(file.state==='applied'||action?.action==='keep_main')continue;
      let entry=file.after;
      if(action?.action==='resolved_file')entry=await this.resolvedEntry(root,action,file.after??undefined);
      if(action?.action==='save_as'){
        if([...actual.keys(),...reserved,...changes.map(c=>c.path)].some(path=>collides(path,action.newPath!))||!entry)throw new Error('save_as_path_exists_or_source_missing');
        changes.push({path:action.newPath!,entry:{...entry,path:action.newPath!}});continue;
      }
      changes.push({path:file.relativePath,entry});
    }
    const tree=await this.git.treeWithEntries(root.repositoryPath,external,changes);
    const merged=await this.git.commitTree(root.repositoryPath,tree,[external,job.mergedCommit!],`Resolve writeback ${job.jobId}`);
    await this.git.updateRef(root.repositoryPath,`refs/metawork/operations/${job.operationId}-revised-${job.conflictVersion}`,merged);
    this.repo.operation({operationId:`${job.operationId}_revision_${job.conflictVersion}`,workspaceId:root.workspaceId,kind:'writeback_revision',expectedRef:job.mergedCommit!,targetCommit:merged,payload:{jobId:job.jobId,external}});
    await this.finishRevision(root,job,`${job.operationId}_revision_${job.conflictVersion}`,job.mergedCommit!,merged,external,verify);
  }
  private async finishRevision(root:WorkspaceGitRoot,job:WorkspaceMergeJob,operationId:string,before:string,merged:string,external:string,verify:()=>Promise<void>):Promise<void> {
    await verify();
    const main=await this.git.ref(root.repositoryPath,'refs/heads/main');
    if(main!==merged)await this.git.updateRef(root.repositoryPath,'refs/heads/main',merged,before);
    const delivered=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
    if(delivered!==external)await this.git.updateRef(root.repositoryPath,'refs/metawork/delivered',external,job.externalCommit!);
    if(job.mergedCommit!==merged) {
      // Clearing the old manifest and publishing the revised identity is one short DB transaction in the repository.
      this.repo.reviseManifest(job.jobId,external,merged);
    }
    this.repo.saveRoot({...root,mainCommit:merged,deliveredCommit:external});
    await this.writeback.manifest(root,job.jobId,external,merged);
    this.repo.operationState(operationId,'applied');
  }

  async cancel(jobId:string,version:number,partialDecision?:'keep_partial',requestId=jobId):Promise<void>{
    const job=this.repo.job(jobId);if(!job)throw new Error('merge_job_not_found');
    const root=this.repo.root(job.workspaceId)!;
    await withWorkspaceGitLock(root.repositoryPath,'integration',async verify=>{
      const replay=this.repo.operationRecord(`cancel_request_${requestId}`);
      if(replay) {if(replay.payload.jobId!==jobId||replay.payload.version!==version||replay.payload.partialDecision!==partialDecision)throw new Error('merge_request_identity_mismatch');if(replay.state==='applied')return;}
      const current=this.repo.job(jobId)!;if(!replay&&current.rowVersion!==version)throw new Error('stale_merge_job');
      const partial=this.repo.files(jobId).some(f=>f.state!=='pending');
      if(partial&&partialDecision!=='keep_partial')throw new Error('partial_writeback_requires_user_decision');
      if(current.state==='delivered')throw new Error('merge_already_delivered');
      if(current.state==='cancelled')return;
      this.repo.operation({operationId:`cancel_request_${requestId}`,workspaceId:root.workspaceId,kind:'cancel_request',payload:{jobId,version,...(partialDecision?{partialDecision}:{})}});
      const before=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
      const preserved=partial?await this.git.capture(root.repositoryPath,root.userRoot,job.mergedCommit??before,'Preserve partially delivered Workspace'):before;
      const operationId=`cancel_${jobId}`;
      await this.git.updateRef(root.repositoryPath,`refs/metawork/operations/${operationId}`,preserved);
      this.repo.operation({operationId,workspaceId:root.workspaceId,kind:'merge_cancel',targetCommit:preserved,payload:{jobId}});
      await this.finishCancellation(root,current,operationId,preserved,verify);
      this.repo.operationState(`cancel_request_${requestId}`,'applied');
    });
    await this.onChanged?.(this.repo.job(jobId)!);
    await this.drain(job.workspaceId);
  }
  private async finishCancellation(root:WorkspaceGitRoot,job:WorkspaceMergeJob,operationId:string,preserved:string,verify:()=>Promise<void>):Promise<void> {
    await verify();
    if(this.repo.head(root.workspaceId)?.jobId===job.jobId) {
      const main=await this.git.ref(root.repositoryPath,'refs/heads/main');
      const delivered=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
      if(![root.mainCommit,job.mergedCommit,job.externalCommit,preserved].includes(main))throw new Error('unexpected_main_during_cancel');
      if(main!==preserved)await this.git.updateRef(root.repositoryPath,'refs/heads/main',preserved,main);
      if(delivered!==preserved)await this.git.updateRef(root.repositoryPath,'refs/metawork/delivered',preserved,delivered);
      await this.git.text(['-C',root.integrationPath,'reset','--hard',preserved]);
      this.repo.saveRoot({...root,mainCommit:preserved,deliveredCommit:preserved});
    }
    if(job.state!=='cancelled')this.repo.updateJob(job.jobId,'cancelled');
    this.repo.operationState(operationId,'applied');
  }
}

function collides(a:string,b:string):boolean { return a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`); }
