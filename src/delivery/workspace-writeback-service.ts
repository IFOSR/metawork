import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { GitTreeEntry, WorkspaceGitRoot, WorkspaceMergeFile } from '../workspace/workspace-git-contracts.js';
import { assertGitPath, type WorkspaceGitService } from '../execution/workspace-git-service.js';
import type { WorkspaceGitPort } from '../workspace/workspace-git-contracts.js';

export class WorkspaceWritebackConflict extends Error {
  constructor(readonly relativePath: string, message: string) { super(`${relativePath}: ${message}`); this.name='WorkspaceWritebackConflict'; }
}

/** Durable per-file writeback. Replays compare actual bytes to both pinned versions. */
export class WorkspaceWritebackService {
  constructor(private readonly git: WorkspaceGitService, private readonly repo: WorkspaceGitPort) {}
  async manifest(root:WorkspaceGitRoot,jobId:string,before:string,after:string):Promise<void> {
    const old=new Map((await this.git.entries(root.repositoryPath,before)).map(e=>[e.path,e]));
    const next=new Map((await this.git.entries(root.repositoryPath,after)).map(e=>[e.path,e]));
    const changed=await this.git.changedFiles(root.repositoryPath,before,after);
    const files:WorkspaceMergeFile[]=[];
    for(const change of changed){
      const a=old.get(change.path)??null,b=next.get(change.path)??null;
      files.push({jobId,ordinal:files.length,relativePath:change.path,before:a,after:b,
        beforeSha256:a?hash(await this.git.blob(root.repositoryPath,a.oid)):null,
        afterSha256:b?hash(await this.git.blob(root.repositoryPath,b.oid)):null,state:'pending',lastError:null});
    }
    this.repo.saveFiles(files);
  }
  async apply(root:WorkspaceGitRoot,jobId:string,verifyOwner:()=>Promise<void>):Promise<void> {
    const files=this.repo.files(jobId);
    // Validate every parent before changing any file. A parent scheduled for removal is handled below.
    for(const file of files) {
      try { await this.assertParents(root.userRoot,file.relativePath,files); }
      catch(error) { this.repo.fileState(jobId,file.ordinal,'conflicted',String(error)); throw error; }
    }
    const ordered=[...files].sort((a,b)=>!a.after&&!b.after?depth(b.relativePath)-depth(a.relativePath):!a.after?-1:!b.after?1:depth(a.relativePath)-depth(b.relativePath));
    for(const file of ordered){
      await verifyOwner();
      const path=join(root.userRoot,file.relativePath);
      try{
        let actual=await observe(path);
        if(!file.after && actual?.kind==='directory' && file.state==='applied'
          && files.some(other=>other.after&&other.relativePath.startsWith(`${file.relativePath}/`)))continue;
        if(actual?.kind==='directory' && !file.before && file.after){
          // Replacing a tracked directory is safe only when its tracked children
          // have already been deleted and no ignored/user files remain.
          await rmdir(path).catch(()=>{throw new WorkspaceWritebackConflict(file.relativePath,'目录仍有用户内容，不能替换');});
          actual=null;
        }
        if(matches(actual,file.after,file.afterSha256) && file.state!=='pending') { this.repo.fileState(jobId,file.ordinal,'applied'); continue; }
        if(!matches(actual,file.before,file.beforeSha256))throw new WorkspaceWritebackConflict(file.relativePath,'用户文件已改变，保留当前内容');
        await this.assertParents(root.userRoot,file.relativePath,[]);
        this.repo.fileState(jobId,file.ordinal,'prepared');
        if(!file.after){
          await unlink(path); await syncDirectory(dirname(path));
          let empty=dirname(path);
          while(empty!==root.userRoot){try{await rmdir(empty);}catch{break;}empty=dirname(empty);}
          this.repo.fileState(jobId,file.ordinal,'applied'); continue;
        }
        await mkdir(dirname(path),{recursive:true});
        const temp=join(dirname(path),`.metawork-write-${jobId}-${file.ordinal}.tmp`);
        await unlink(temp).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
        const content=await this.git.blob(root.repositoryPath,file.after.oid);
        if(file.after.kind==='symlink')await symlink(content.toString('utf8'),temp);
        else {
          const handle=await open(temp,'wx',actual?.permissions??0o666);
          try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
          const permissions=actual?.permissions;
          if(permissions!==undefined) await chmod(temp,(permissions & ~0o111)|(file.after.mode==='100755'?0o111:0));
          else if(file.after.mode==='100755')await chmod(temp,0o755);
        }
        await verifyOwner(); await this.assertParents(root.userRoot,file.relativePath,[]);
        if(!matches(await observe(path),file.before,file.beforeSha256))throw new WorkspaceWritebackConflict(file.relativePath,'写入前文件再次改变');
        if(file.before)await rename(temp,path);
        else if(file.after.kind==='symlink'){
          await symlink(content.toString('utf8'),path);await unlink(temp);
        }else{ await link(temp,path);await unlink(temp); }
        if(!matches(await observe(path),file.after,file.afterSha256))throw new WorkspaceWritebackConflict(file.relativePath,'写入后内容校验失败');
        await syncDirectory(dirname(path));
        this.repo.fileState(jobId,file.ordinal,'applied');
      }catch(error){
        const latest=this.repo.files(jobId).find(value=>value.ordinal===file.ordinal)!;
        this.repo.fileState(jobId,file.ordinal,error instanceof WorkspaceWritebackConflict?'conflicted':latest.state,String(error));throw error;
      }
    }
    await this.verify(root,jobId);
    // Only empty directories; ignored/untracked user content can never be recursively removed.
    const parents=[...new Set(files.filter(f=>!f.after).map(f=>dirname(f.relativePath)))].sort((a,b)=>depth(b)-depth(a));
    for(const parent of parents)if(parent!=='.')await rmdir(join(root.userRoot,parent)).catch(()=>{});
  }
  async verify(root:WorkspaceGitRoot,jobId:string):Promise<void>{
    for(const file of this.repo.files(jobId)){
      const actual=await observe(join(root.userRoot,file.relativePath));
      // A deleted file can now be a directory because a child was added.
      const replacedByDirectory=!file.after && actual?.kind==='directory' && this.repo.files(jobId).some(other=>other.after&&other.relativePath.startsWith(`${file.relativePath}/`));
      if(!replacedByDirectory && !matches(actual,file.after,file.afterSha256)){
        this.repo.fileState(jobId,file.ordinal,'conflicted','交付复核时文件已改变');
        throw new WorkspaceWritebackConflict(file.relativePath,'交付复核时文件已改变');
      }
    }
  }
  /** A decision about another file cannot silently accept edits to applied files. */
  async auditApplied(root:WorkspaceGitRoot, jobId:string):Promise<boolean> {
    let changed = false;
    const files = this.repo.files(jobId);
    for (const file of files.filter(value => value.state === 'applied')) {
      try {
        await this.assertParents(root.userRoot, file.relativePath, []);
        const actual = await observe(join(root.userRoot, file.relativePath));
        const directoryReplacement = !file.after && actual?.kind === 'directory'
          && files.some(other => other.after && other.relativePath.startsWith(`${file.relativePath}/`));
        if (!directoryReplacement && !matches(actual, file.after, file.afterSha256)) throw new Error('已写回文件再次被修改');
      } catch (error) {
        this.repo.fileState(jobId, file.ordinal, 'conflicted', String(error));
        changed = true;
      }
    }
    return changed;
  }
  private async assertParents(root:string,path:string,files:WorkspaceMergeFile[]):Promise<void>{
    assertGitPath(path);
    let parent=dirname(path);
    while(parent!=='.'){
      const info=await lstat(join(root,parent)).catch(error=>{if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;});
      if(info&&!info.isDirectory()&&!files.some(file=>file.relativePath===parent&&!file.after))throw new WorkspaceWritebackConflict(path,'父目录不是普通目录');
      parent=dirname(parent);
    }
    if(relative(root,join(root,path)).startsWith('..'))throw new Error('writeback_path_escape');
  }
}
interface Actual {kind:string;sha256:string;executable:boolean;permissions:number;}
async function observe(path:string):Promise<Actual|null>{
  const info=await lstat(path).catch(error=>{if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;});
  if(!info)return null;
  if(!info.isFile()&&!info.isSymbolicLink())return {kind:'directory',sha256:'',executable:false,permissions:info.mode&0o777};
  return {kind:info.isSymbolicLink()?'symlink':'file',sha256:hash(info.isSymbolicLink()?Buffer.from(await readlink(path)):await readFile(path)),executable:!!(info.mode&0o111),permissions:info.mode&0o777};
}
function matches(actual:Actual|null,entry:GitTreeEntry|null,digest:string|null):boolean{
  if(!entry)return actual===null;
  return actual?.kind===entry.kind&&actual.sha256===digest&&(entry.kind==='symlink'||actual.executable===(entry.mode==='100755'));
}
function depth(path:string):number{return path.split('/').length;}
function hash(value:Buffer):string{return createHash('sha256').update(value).digest('hex');}

async function syncDirectory(path:string):Promise<void>{
  const handle=await open(path,'r');
  try{await handle.sync();}finally{await handle.close();}
}
