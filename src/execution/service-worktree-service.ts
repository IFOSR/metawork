import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedPathSegment } from '../utils/bounded-path-segment.js';
import type { ServiceGitWorktree, WorkspaceGitPort } from '../workspace/workspace-git-contracts.js';
import { assertGitPath, WorkspaceGitService } from './workspace-git-service.js';
import { withWorkspaceGitLock } from './workspace-git-lock.js';

/** Running services own their checkout; Conversation cleanup can never remove it. */
export class ServiceWorktreeService {
  constructor(private readonly git:WorkspaceGitService,private readonly repo:WorkspaceGitPort) {}
  async prepare(taskId:string,serviceId:string,projectPath=''):Promise<ServiceGitWorktree> {
    if(projectPath && projectPath!=='.')assertGitPath(projectPath);
    const source=this.repo.sourceForTask(taskId);if(!source)throw new Error('service_source_commit_missing');
    const root=this.repo.root(source.workspaceId);if(!root||root.state!=='ready')throw new Error('workspace_not_ready');
    return withWorkspaceGitLock(root.repositoryPath,'metadata',async()=>{
      let record=this.repo.serviceWorktree(source.workspaceId,serviceId,source.commit);
      if(record && ['ready','running','stopped','retained'].includes(record.state)) {
        if(record.projectPath!==projectPath)throw new Error('service_project_path_mismatch');
        await this.validate(root.repositoryPath,record);return record;
      }
      record??={serviceWorktreeId:`swt_${randomUUID()}`,workspaceId:source.workspaceId,serviceId,sourceTaskId:taskId,
        sourceCommit:source.commit,projectPath,rootPath:join(dirname(root.repositoryPath),'services',boundedPathSegment(serviceId,{prefix:'s'}),source.commit),
        state:'preparing',processToken:null,runtimeDirty:false};
      this.repo.saveServiceWorktree(record);
      // Pin before registering a checkout; interrupted preparation is retryable.
      await this.git.updateRef(root.repositoryPath,`refs/metawork/services/${record.serviceWorktreeId}`,source.commit);
      await mkdir(dirname(record.rootPath),{recursive:true,mode:0o700});
      if(!await lstat(join(record.rootPath,'.git')).then(()=>true,()=>false))
        await this.git.text(['--git-dir',root.repositoryPath,'worktree','add','--detach',record.rootPath,source.commit]);
      await this.validate(root.repositoryPath,record);
      record={...record,state:'ready'};this.repo.saveServiceWorktree(record);return record;
    });
  }
  isPrepared(record:ServiceGitWorktree):boolean {
    return this.repo.operationRecord(`service_prepared_${record.serviceWorktreeId}`)?.state==='applied';
  }
  async resolvePreparation(taskId:string,serviceId:string,identity:{serviceWorktreeId:string;sourceCommit:string;projectPath:string}):Promise<ServiceGitWorktree> {
    const source=this.repo.sourceForTask(taskId);
    if(!source || source.commit!==identity.sourceCommit)throw new Error('stale_service_source');
    const record=this.repo.serviceWorktree(source.workspaceId,serviceId,source.commit);
    if(!record||record.serviceWorktreeId!==identity.serviceWorktreeId||record.projectPath!==identity.projectPath
      ||record.state==='running'||record.state==='cleaned')throw new Error('stale_service_worktree');
    await this.validate(this.repo.root(source.workspaceId)!.repositoryPath,record);
    return record;
  }
  async markPrepared(record:ServiceGitWorktree):Promise<void> {
    const root=this.repo.root(record.workspaceId)!;
    await this.validate(root.repositoryPath,record);
    // Install/build may create caches and outputs; the pinned source is never rewritten.
    const tracked=await this.git.entries(root.repositoryPath,record.sourceCommit);
    const candidate=await this.git.capture(root.repositoryPath,record.rootPath,record.sourceCommit,'Validate service preparation');
    const actual=new Map((await this.git.entries(root.repositoryPath,candidate)).map(e=>[e.path,e]));
    for(const entry of tracked) {
      const current=actual.get(entry.path);
      if(!current||current.oid!==entry.oid||current.mode!==entry.mode)throw new Error(`service_source_modified:${entry.path}`);
    }
    const operationId=`service_prepared_${record.serviceWorktreeId}`;
    const previous=this.repo.operationRecord(operationId);
    if(previous?.state==='applied')return;
    const preparedCommit=previous?.targetCommit??candidate;
    this.repo.operation({operationId,workspaceId:record.workspaceId,kind:'service_prepared',targetCommit:preparedCommit,
      payload:{serviceWorktreeId:record.serviceWorktreeId,sourceCommit:record.sourceCommit}});
    await this.git.updateRef(root.repositoryPath,`refs/metawork/operations/${operationId}`,preparedCommit);
    this.repo.operationState(operationId,'applied');
  }
  private async validate(repositoryPath:string,record:ServiceGitWorktree):Promise<void> {
    const common=await this.git.text(['-C',record.rootPath,'rev-parse','--path-format=absolute','--git-common-dir']);
    const head=await this.git.text(['-C',record.rootPath,'rev-parse','HEAD']);
    if(await realpath(common)!==await realpath(repositoryPath)||head!==record.sourceCommit)throw new Error('service_worktree_identity_mismatch');
  }
  async observe(record:{workspaceId:string|null;sourceCommit?:string|null;specification:{serviceId:string};processToken:string|null;state:string}):Promise<void> {
    if(!record.workspaceId||!record.sourceCommit)return;
    const worktree=this.repo.serviceWorktree(record.workspaceId,record.specification.serviceId,record.sourceCommit);
    if(!worktree)return;
    const active=['starting','running','healthy','unhealthy'].includes(record.state);
    let dirty=worktree.runtimeDirty;
    if(!active) {
      const root=this.repo.root(record.workspaceId)!;
      // Include ignored runtime data in the dirty check, while never reading .git.
      const entries=await this.git.scan(worktree.rootPath);
      const tracked=await this.git.entries(root.repositoryPath,worktree.sourceCommit);
      const tree=await this.git.capture(root.repositoryPath,worktree.rootPath,worktree.sourceCommit,'Inspect stopped service data');
      const status=await this.git.text(['-C',worktree.rootPath,'status','--porcelain','--untracked-files=all','--ignored']);
      dirty=dirty||tree!==worktree.sourceCommit||!!status||entries.length!==tracked.length;
    }
    this.repo.saveServiceWorktree({...worktree,state:active?'running':dirty?'retained':'stopped',processToken:record.processToken,runtimeDirty:dirty});
  }
}
