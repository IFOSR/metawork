import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { WorkspaceGitRepo } from '../../src/storage/workspace-git-repo.js';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';
import { ConversationWorktreeService } from '../../src/execution/conversation-worktree-service.js';
import { WorkspaceMergeWorker } from '../../src/execution/workspace-merge-worker.js';

describe('Workspace Task FIFO delivery',()=>{
  let directory:string,userRoot:string,db:Database.Database,repo:WorkspaceGitRepo,git:WorkspaceGitService,conversations:ConversationWorktreeService,worker:WorkspaceMergeWorker;
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'metawork-merge-'));userRoot=join(directory,'user');await mkdir(userRoot);
    db=new Database(':memory:');runMigrations(db);repo=new WorkspaceGitRepo(db);
    git=new WorkspaceGitService({internalRoot:join(directory,'runtime')});conversations=new ConversationWorktreeService(git,repo);worker=new WorkspaceMergeWorker(git,repo);
  });
  afterEach(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  async function session(id:string){
    const task=new TaskEngine(new TaskRepo(db),join(directory,'snapshots')).create({title:id,goal:id,accountId:'a',conversationId:id,workspaceId:'w'});
    return conversations.bind({accountId:'a',workspaceId:'w',conversationId:id,userRoot,taskId:task.id,generationId:'g'});
  }
  async function enqueue(binding:Awaited<ReturnType<typeof session>>){
    await conversations.sealAttempt(binding,`attempt_${binding.taskId}`);
    const result=await conversations.sealTask(binding.taskId,'g');
    return repo.enqueue(result.changeId!,`request_${binding.taskId}`);
  }
  test('merges isolated conversations in FIFO order and includes external user edits',async()=>{
    await writeFile(join(userRoot,'base.txt'),'base');
    const one=await session('one'),two=await session('two');
    await writeFile(join(one.executionRoot,'one.md'),'one');await writeFile(join(two.executionRoot,'two.md'),'two');
    const first=await enqueue(one),second=await enqueue(two);
    expect(second.sequence).toBe(first.sequence+1);
    expect(repo.enqueue(first.changeId,first.requestId).jobId).toBe(first.jobId);
    await writeFile(join(userRoot,'external.md'),'external');
    await worker.drain('w');
    expect(repo.queue('w').map(j=>j.state)).toEqual(['delivered','delivered']);
    for(const name of ['one','two','external'])expect(await readFile(join(userRoot,`${name}.md`),'utf8')).toBe(name);
    await worker.drain('w');
    expect(await git.ref(repo.root('w')!.repositoryPath,'refs/heads/main')).toBe(await git.ref(repo.root('w')!.repositoryPath,'refs/metawork/delivered'));
  });
  test('same-line conflicts preserve user files, block only FIFO delivery and accept explicit resolution',async()=>{
    await writeFile(join(userRoot,'report.md'),'base\n');
    const one=await session('one'),two=await session('two'),three=await session('three');
    await writeFile(join(one.executionRoot,'report.md'),'one\n');await writeFile(join(two.executionRoot,'report.md'),'two\n');
    const first=await enqueue(one),second=await enqueue(two);
    await worker.drain('w');
    expect(repo.job(first.jobId)?.state).toBe('delivered');expect(repo.job(second.jobId)?.state).toBe('conflicted');
    expect(await readFile(join(userRoot,'report.md'),'utf8')).toBe('one\n');
    await writeFile(join(three.executionRoot,'parallel.md'),'still executes');
    const third=await enqueue(three);await worker.drain('w');expect(repo.job(third.jobId)?.state).toBe('queued');
    const conflict=await worker.conflicts(second.jobId);expect(conflict.paths).toEqual(['report.md']);
    await worker.resolve({jobId:second.jobId,requestId:'resolve',expectedConflictVersion:conflict.job.conflictVersion,actions:[{path:'report.md',action:'take_session'}]});
    expect(repo.job(second.jobId)?.state).toBe('delivered');expect(repo.job(third.jobId)?.state).toBe('delivered');
    expect(await readFile(join(userRoot,'report.md'),'utf8')).toBe('two\n');
  });
});
