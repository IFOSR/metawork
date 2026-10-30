import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { WorkspaceGitPort } from '../workspace/workspace-git-contracts.js';
import type { ConversationExecutionBinding, ConversationGitWorktree, WorkspaceGitRoot } from '../workspace/workspace-git-contracts.js';
import { WorkspaceGitService } from './workspace-git-service.js';
import { withWorkspaceGitLock } from './workspace-git-lock.js';

export function conversationBindingFingerprint(binding: Omit<ConversationExecutionBinding,'bindingFingerprint'|'createdAt'>): string {
  return createHash('sha256').update(JSON.stringify([binding.bindingVersion,binding.taskId,binding.generationId,binding.workspaceId,
    binding.conversationId,binding.worktreeId,binding.incarnation,binding.userRoot,binding.executionRoot,binding.taskBaseCommit])).digest('hex');
}

export class ConversationWorktreeService {
  private readonly pending=new Map<string,Promise<unknown>>();
  private readonly initializations = new Map<string, Promise<WorkspaceGitRoot>>();
  private readonly cleanups = new Map<string, Promise<void>>();
  constructor(readonly git:WorkspaceGitService,readonly repo:WorkspaceGitPort){}
  beginInitialize(input:{accountId:string;workspaceId:string;userRoot:string}): { state: WorkspaceGitRoot['state']; ready: Promise<WorkspaceGitRoot> } {
    const existing = this.repo.root(input.workspaceId);
    if (existing?.state === 'ready') return { state: 'ready', ready: Promise.resolve(existing) };
    const active = this.initializations.get(input.workspaceId);
    if (active) return { state: 'initializing', ready: active };
    const ready = this.initialize(input).finally(() => {
      if (this.initializations.get(input.workspaceId) === ready) this.initializations.delete(input.workspaceId);
    });
    this.initializations.set(input.workspaceId, ready);
    void ready.catch(() => undefined);
    return { state: 'initializing', ready };
  }
  state(workspaceId:string): WorkspaceGitRoot['state'] {
    return this.repo.root(workspaceId)?.state ?? (this.initializations.has(workspaceId) ? 'initializing' : 'failed');
  }
  error(workspaceId:string): string | null {
    return this.repo.root(workspaceId)?.lastError ?? null;
  }
  beginCleanup(conversationId:string): { state: 'cleaning' | 'retained' | 'cleaned'; ready: Promise<void> } {
    const worktree = this.repo.conversation(conversationId);
    if (!worktree) return { state: 'cleaned', ready: Promise.resolve() };
    const active = this.cleanups.get(conversationId);
    if (active) return { state: 'cleaning', ready: active };
    this.repo.requestCleanup(worktree.worktreeId);
    if (this.repo.conversationState(worktree.worktreeId).ownerToken || this.repo.cleanupBlocked(worktree.worktreeId)) {
      return { state: 'retained', ready: Promise.resolve() };
    }
    const ready = this.cleanupNow(conversationId).finally(() => {
      if (this.cleanups.get(conversationId) === ready) this.cleanups.delete(conversationId);
    });
    this.cleanups.set(conversationId, ready);
    void ready.catch(() => undefined);
    return { state: 'cleaning', ready };
  }
  async initialize(input:{accountId:string;workspaceId:string;userRoot:string}):Promise<WorkspaceGitRoot>{
    return this.serial(`root:${input.workspaceId}`,async()=>{
      const existing=this.repo.root(input.workspaceId);
      if(existing?.state==='ready') {
        if (existing.accountId !== input.accountId || existing.userRoot !== await realpath(input.userRoot)) throw new Error('workspace_identity_mismatch');
        await withWorkspaceGitLock(existing.repositoryPath, 'integration', () => this.git.validateRoot(existing));
        return existing;
      }
      const canonicalInput = {...input, userRoot: await realpath(input.userRoot)};
      if(existing?.mainCommit || existing?.deliveredCommit)throw new Error('workspace_git_requires_recovery');
      this.repo.saveRoot({...canonicalInput,...this.git.paths(input.workspaceId),mainCommit:'',deliveredCommit:'',state:'initializing',lastError:null});
      const operationId = `initialize_${input.workspaceId}`;
      this.repo.operation({operationId, workspaceId: input.workspaceId, kind: 'initialize', payload: canonicalInput});
      try{
        // The parent exists before the bare repository, so initialization serializes locally.
        const root=await this.git.initialize(canonicalInput);this.repo.saveRoot(root);
        this.repo.operationState(operationId, 'applied');return root;
      }catch(error){this.repo.failRoot(input.workspaceId,String(error));throw error;}
    });
  }
  async ensure(root:WorkspaceGitRoot,conversationId:string):Promise<ConversationGitWorktree>{
    return this.serial(`conversation:${conversationId}`,async()=>{
      const existing=this.repo.conversation(conversationId);
      if(existing){if(existing.workspaceId!==root.workspaceId)throw new Error('conversation_workspace_mismatch');await this.git.validateWorktree(existing);return existing;}
      return withWorkspaceGitLock(root.repositoryPath,'metadata',async()=>{
        const existing = this.repo.conversation(conversationId);
        if (existing) { await this.git.validateWorktree(existing); return existing; }
        const incarnation = this.repo.nextIncarnation(conversationId);
        const operationId = `create_${conversationId}_${incarnation}`;
        this.repo.operation({operationId, workspaceId: root.workspaceId, kind: 'create_conversation', payload: {conversationId, incarnation}});
        const result = this.repo.saveConversation(await this.git.ensureConversation(this.repo.root(root.workspaceId)!, conversationId, incarnation));
        this.repo.operationState(operationId, 'applied');return result;
      });
    });
  }
  async prepareTurn(root:WorkspaceGitRoot,conversationId:string):Promise<ConversationGitWorktree>{
    await this.importExternal(root);
    await this.ensure(root,conversationId);
    return withWorkspaceGitLock(root.repositoryPath,'metadata',async()=>{
      const worktree=this.repo.conversation(conversationId)!;
      const state=this.repo.conversationState(worktree.worktreeId);
      // A Planner can inspect retained work. Binding a different Task below is refused.
      if(state.state!=='idle'||state.ownerToken||this.repo.hasUndeliveredChanges(conversationId)
        || this.repo.heldBaseCommit(conversationId))return worktree;
      const delivered=await this.git.ref(root.repositoryPath,'refs/metawork/delivered');
      // Inspect even when refs agree: a failed or interrupted Attempt may have
      // left unsealed bytes. Planner can inspect them, but a new Task cannot bind.
      if (!(await this.git.isWorktreeClean(worktree.rootPath, worktree.headCommit))) return worktree;
      if(worktree.headCommit===delivered)return worktree;
      if (!(await this.git.isAncestor(root.repositoryPath, worktree.headCommit, delivered))) return worktree;
      const operationId = `sync_${worktree.worktreeId}_${delivered}`;
      this.repo.operation({operationId,workspaceId:root.workspaceId,kind:'sync_conversation',expectedRef:worktree.headCommit,targetCommit:delivered,payload:{conversationId}});
      const result = this.repo.saveConversation(await this.git.syncConversation(worktree,delivered));
      this.repo.operationState(operationId,'applied');return result;
    });
  }
  /** Import user edits through the same integration mutex, only with an idle FIFO. */
  async importExternal(root:WorkspaceGitRoot,explicitPaths:string[]=[]):Promise<void> {
    await withWorkspaceGitLock(root.repositoryPath,'integration',async verify=>{
      if(this.repo.head(root.workspaceId))return;
      root=this.repo.root(root.workspaceId)!;
      await this.git.validateRoot(root);
      const delivered=root.deliveredCommit;
      const external=await this.git.captureUserRoot(root.repositoryPath,root.userRoot,delivered,'Observe user Workspace edits',explicitPaths);
      if(external===delivered)return;
      const operationId=`external_${delivered}_${external}`;
      this.repo.operation({operationId,workspaceId:root.workspaceId,kind:'external',expectedRef:delivered,targetCommit:external});
      await this.git.updateRef(root.repositoryPath,`refs/metawork/operations/${operationId}`,external);
      await verify();
      await this.git.updateRef(root.repositoryPath,'refs/heads/main',external,delivered);
      await this.git.updateRef(root.repositoryPath,'refs/metawork/delivered',external,delivered);
      await this.git.text(['-C',root.integrationPath,'reset','--hard',external]);
      await this.git.refreshSourceIndex(root.repositoryPath, root.userRoot, external);
      this.repo.saveRoot({...root,mainCommit:external,deliveredCommit:external});
      this.repo.operationState(operationId,'applied');
    });
  }
  /** Hold the exact Planner observation until the RPC/proposal window closes. */
  async observe(root: WorkspaceGitRoot, conversationId: string): Promise<{rootPath: string; release(): Promise<void>}> {
    const prepared = await this.prepareTurn(root, conversationId);
    const token = `planner_${randomUUID()}`;
    const operationId = token;
    const worktree = await withWorkspaceGitLock(root.repositoryPath, 'metadata', async () => {
      const current = this.repo.conversation(conversationId)!;
      if (current.worktreeId !== prepared.worktreeId || !this.repo.claimPlanner(conversationId, token)) throw new Error('conversation_writer_active');
      try {
        this.repo.operation({operationId, workspaceId: root.workspaceId, kind: 'planner_observation',
          expectedRef: current.headCommit, payload: {conversationId, worktreeId: current.worktreeId, incarnation: current.incarnation, token, pid: process.pid}});
      } catch (error) { this.repo.releaseConversation(conversationId, token); throw error; }
      return current;
    });
    return {rootPath: worktree.rootPath, release: async () => {
      await withWorkspaceGitLock(root.repositoryPath, 'metadata', async () => {
        this.repo.operationState(operationId, 'applied');
        this.repo.releaseConversation(conversationId, token);
      });
    }};
  }
  async validateBinding(binding:ConversationExecutionBinding):Promise<void>{
    const worktree=this.repo.conversation(binding.conversationId);
    const {bindingFingerprint:_fingerprint,createdAt:_created,...facts}=binding;
    if(!worktree||worktree.worktreeId!==binding.worktreeId||worktree.incarnation!==binding.incarnation
      ||worktree.rootPath!==binding.executionRoot||worktree.userRoot!==binding.userRoot
      ||conversationBindingFingerprint(facts)!==binding.bindingFingerprint)throw new Error('stale_conversation_binding');
    await this.git.validateWorktree(worktree);
    await withWorkspaceGitLock(worktree.repositoryPath,'integration',async()=>{
      await this.git.validateRoot(this.repo.root(binding.workspaceId)!);
    });
  }
  async bind(input:{accountId:string;workspaceId:string;conversationId:string;userRoot:string;taskId:string;generationId:string}):Promise<ConversationExecutionBinding>{
    const existing=this.repo.binding(input.taskId,input.generationId);if(existing)return existing;
    const root=await this.initialize(input);
    const worktree=await this.prepareTurn(root,input.conversationId);
    if(this.repo.hasUndeliveredChanges(input.conversationId,input.taskId))throw new Error('conversation_has_undelivered_work');
    const owner = this.repo.conversationState(worktree.worktreeId).ownerToken;
    if (owner && !owner.startsWith('planner_')) throw new Error('conversation_attempt_active');
    if (owner) {
      const observation = this.repo.operationRecord(owner);
      if (!observation || observation.state === 'applied' || observation.expectedRef !== worktree.headCommit
        || observation.payload.worktreeId !== worktree.worktreeId || observation.payload.incarnation !== worktree.incarnation) throw new Error('stale_planner_context');
    }
    const clean = await this.git.isWorktreeClean(worktree.rootPath, worktree.headCommit);
    const prior = this.repo.latestBinding(input.conversationId);
    const ownRetainedWork = prior?.taskId === input.taskId && prior.worktreeId === worktree.worktreeId;
    if(!clean || (!ownRetainedWork && !(await this.git.isAncestor(root.repositoryPath,worktree.headCommit,(this.repo.root(root.workspaceId)!).deliveredCommit))))throw new Error('conversation_has_unsealed_or_undelivered_work');
    const heldBase = ownRetainedWork ? null : this.repo.heldBaseCommit(input.conversationId);
    const taskBaseCommit = ownRetainedWork ? prior.taskBaseCommit : heldBase ?? worktree.headCommit;
    const facts={bindingVersion:'conversation-git-v1' as const,taskId:input.taskId,generationId:input.generationId,workspaceId:input.workspaceId,
      conversationId:input.conversationId,worktreeId:worktree.worktreeId,incarnation:worktree.incarnation,userRoot:root.userRoot,
      executionRoot:worktree.rootPath,taskBaseCommit};
    return this.repo.bind({...facts,bindingFingerprint:conversationBindingFingerprint(facts),createdAt:new Date().toISOString()});
  }
  async sealAttempt(binding:ConversationExecutionBinding,attemptId:string,explicitPaths:string[]=[]):Promise<{commit:string;changedPaths:string[]}>{
    await this.validateBinding(binding);
    return withWorkspaceGitLock(this.repo.root(binding.workspaceId)!.repositoryPath,'metadata',async()=>{
      const worktree=this.repo.conversation(binding.conversationId)!;
      const operationId=`seal_${attemptId}`;
      const old=this.repo.operationRecord(operationId);
      const before=old?.expectedRef??worktree.headCommit;
      // Persist the exact candidate before changing any trusted branch. Replays never rescan.
      const commit=old?.targetCommit??await this.git.capture(worktree.repositoryPath,worktree.rootPath,before,`Capture Attempt ${attemptId}`,explicitPaths);
      this.repo.operation({operationId,workspaceId:binding.workspaceId,kind:'seal',expectedRef:before,targetCommit:commit,payload:{attemptId}});
      await this.git.updateRef(worktree.repositoryPath,`refs/metawork/operations/${operationId}`,commit);
      if(old?.state!=='applied'){
        const actual=await this.git.ref(worktree.repositoryPath,`refs/heads/${worktree.branch}`);
        // Model commits on its own branch are replaced by the captured file tree.
        if(actual!==commit)await this.git.updateRef(worktree.repositoryPath,`refs/heads/${worktree.branch}`,commit,actual);
        await this.git.text(['-C',worktree.rootPath,'read-tree',commit]);
        this.repo.saveConversation({...worktree,headCommit:commit});
        this.repo.recordAttemptCommit(attemptId,{...worktree,headCommit:before},commit);
        this.repo.operationState(operationId,'applied');
      }
      return {commit,changedPaths:(await this.git.changedFiles(worktree.repositoryPath,before,commit)).map(file=>file.path)};
    });
  }
  async sealTask(taskId:string,generationId:string,held=false):Promise<{changeId:string|null;commit:string;hasChanges:boolean}>{
    const binding=this.repo.binding(taskId,generationId);if(!binding)throw new Error('conversation_execution_binding_missing');
    const worktree=this.repo.conversation(binding.conversationId)!;
    const changes=await this.git.changedFiles(worktree.repositoryPath,binding.taskBaseCommit,worktree.headCommit);
    const existing=this.repo.operationRecord(`task_seal_${taskId}_${generationId}`);
    if(existing?.targetCommit && typeof existing.payload.changeId==='string') {
      // A later turn may already have advanced the session. A Task result never follows it.
      await this.git.updateRef(worktree.repositoryPath,`refs/metawork/results/${existing.payload.changeId}`,existing.targetCommit);
      this.repo.change(binding,existing.targetCommit,held,existing.payload.changeId);
      this.repo.operationState(`task_seal_${taskId}_${generationId}`,'applied');
      return {changeId:existing.payload.changeId,commit:existing.targetCommit,hasChanges:true};
    }
    if(existing?.targetCommit && existing.payload.noChanges===true)return {changeId:null,commit:existing.targetCommit,hasChanges:false};
    if(!changes.length){
      this.repo.operation({operationId:`task_seal_${taskId}_${generationId}`,workspaceId:binding.workspaceId,kind:'task_seal',targetCommit:worktree.headCommit,payload:{noChanges:true}});
      await this.git.updateRef(worktree.repositoryPath,`refs/metawork/operations/task_seal_${taskId}_${generationId}`,worktree.headCommit);
      this.repo.operationState(`task_seal_${taskId}_${generationId}`,'applied');
      return {changeId:null,commit:worktree.headCommit,hasChanges:false};
    }
    const changeId=typeof existing?.payload.changeId==='string'?existing.payload.changeId:`change_${randomUUID()}`;
    this.repo.operation({operationId:`task_seal_${taskId}_${generationId}`,workspaceId:binding.workspaceId,kind:'task_seal',targetCommit:worktree.headCommit,payload:{changeId}});
    await this.git.updateRef(worktree.repositoryPath,`refs/metawork/results/${changeId}`,worktree.headCommit);
    this.repo.change(binding,worktree.headCommit,held,changeId);
    this.repo.operationState(`task_seal_${taskId}_${generationId}`,'applied');
    return {changeId,commit:worktree.headCommit,hasChanges:true};
  }
  markNoChanges(taskId:string,generationId:string):void {
    const binding=this.repo.binding(taskId,generationId);if(!binding)throw new Error('conversation_execution_binding_missing');
    const operationId=`task_delivery_${taskId}_${generationId}`;
    this.repo.operation({operationId,workspaceId:binding.workspaceId,kind:'task_no_changes',payload:{taskId,generationId}});
    this.repo.operationState(operationId,'applied');
  }
  async requestCleanup(conversationId:string):Promise<void>{
    await this.beginCleanup(conversationId).ready;
  }
  private async cleanupNow(conversationId:string):Promise<void>{
    const worktree=this.repo.conversation(conversationId);if(!worktree)return;
    this.repo.requestCleanup(worktree.worktreeId);
    if(this.repo.conversationState(worktree.worktreeId).ownerToken||this.repo.cleanupBlocked(worktree.worktreeId))return;
    await withWorkspaceGitLock(worktree.repositoryPath,'metadata',async()=>{
      if(this.repo.conversationState(worktree.worktreeId).ownerToken||this.repo.cleanupBlocked(worktree.worktreeId))return;
      this.repo.setConversationState(worktree.worktreeId,'cleaning');
      const operationId=`cleanup_${worktree.worktreeId}`;
      if(!this.repo.operationRecord(operationId)) {
        if(!(await this.git.isWorktreeClean(worktree.rootPath, worktree.headCommit))){this.repo.setConversationState(worktree.worktreeId,'retained');return;}
      }
      this.repo.operation({operationId,workspaceId:worktree.workspaceId,kind:'cleanup_conversation',payload:{conversationId,worktreeId:worktree.worktreeId}});
      try { await this.git.removeConversation(worktree); }
      catch (error) {
        this.repo.setConversationState(worktree.worktreeId, 'retained');
        this.repo.operationState(operationId, 'needs_recovery');
        throw error;
      }
      this.repo.setConversationState(worktree.worktreeId,'cleaned');
      this.repo.operationState(operationId,'applied');
    });
  }
  private async serial<T>(key:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.pending.get(key)??Promise.resolve();
    const next=previous.catch(()=>{}).then(action);this.pending.set(key,next);
    try{return await next;}finally{if(this.pending.get(key)===next)this.pending.delete(key);}
  }
}
