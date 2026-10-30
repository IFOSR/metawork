import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface Owner { pid: number; token: string; processStart?: string; }
const execFileAsync=promisify(execFile);
async function processStart(pid:number):Promise<string|null> {
  return execFileAsync('ps',['-p',String(pid),'-o','lstart='],{timeout:5000})
    .then(r=>r.stdout.trim()||null,()=>null);
}
async function ownerAlive(value:Owner):Promise<boolean> {
  if(!alive(value.pid))return false;
  if(!value.processStart)return true;
  const current=await processStart(value.pid);
  return !current || current===value.processStart;
}
async function gitLocked(root:string):Promise<boolean> {
  const {readdir}=await import('node:fs/promises');
  const direct=['index.lock','HEAD.lock','packed-refs.lock','refs/heads/main.lock'];
  if((await Promise.all(direct.map(p=>stat(join(root,p)).then(()=>true,()=>false)))).some(Boolean))return true;
  const worktrees=await readdir(join(root,'worktrees')).catch(()=>[]);
  for(const worktree of worktrees)for(const file of ['index.lock','HEAD.lock'])
    if(await stat(join(root,'worktrees',worktree,file)).then(()=>true,()=>false))return true;
  return false;
}
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function owner(path: string): Promise<Owner | null> {
  return readFile(join(path, 'owner.json'), 'utf8').then(value => JSON.parse(value) as Owner, () => null);
}
async function reclaimStale(path: string): Promise<void> {
  const existing = await owner(path);
  if (existing) {
    if (!await ownerAlive(existing)) await rm(path, { recursive: true, force: true });
    return;
  }
  // A server can die after mkdir(reclaim) and before publishing its witness.
  // Treat only an old empty directory as abandoned; a fresh one remains a
  // fence so two contenders cannot both reclaim the Git lock.
  const info = await stat(path).catch(() => null);
  if (info && Date.now() - info.mtimeMs > 1_000) await rm(path, { recursive: true, force: true });
}
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Short local metadata/integration mutex. Expiry alone never revokes a live owner. */
export async function withWorkspaceGitLock<T>(repositoryPath: string, name: string, action: (verify: () => Promise<void>) => Promise<T>): Promise<T> {
  const path = join(repositoryPath, `metawork-${name}.lock`);
  const reclaim = `${path}.reclaim`;
  const token = randomUUID();
  const deadline = Date.now() + 120_000;
  // Publish the directory together with its owner. A crash cannot leave the
  // acquisition gap of mkdir(lock) followed by write(owner).
  const candidate=`${path}.candidate-${token}`;
  const {rename}=await import('node:fs/promises');
  await mkdir(candidate);
  await writeFile(join(candidate,'owner.json'),JSON.stringify({pid:process.pid,token,processStart:await processStart(process.pid)}));
  for (;;) {
    try { await rename(candidate,path); break; }
    catch (error) { if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??'')) { await rm(candidate,{recursive:true,force:true}); throw error; } }
    const previous = await owner(path);
    // The empty-owner interval during acquisition is not a dead process.
    if (previous && !await ownerAlive(previous)) {
      let fence = false;
      try {
        await mkdir(reclaim); fence = true;
        await writeFile(join(reclaim, 'owner.json'), JSON.stringify({pid:process.pid,token}));
        const current = await owner(path);
        if (current?.token === previous.token && !await ownerAlive(current)) {
          // Git children may outlive the parent: their index/ref locks prohibit takeover.
          if (await gitLocked(repositoryPath)) throw new Error('workspace_git_orphan_child_requires_recovery');
          await rm(path, { recursive: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') await reclaimStale(reclaim);
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      finally { if (fence) await rm(reclaim, { recursive: true, force: true }); }
    }
    if (Date.now() >= deadline) { await rm(candidate,{recursive:true,force:true}); throw new Error(`workspace_git_busy:${name}`); }
    await pause();
  }
  const verify = async () => {
    if ((await owner(path))?.token !== token) throw new Error('workspace_git_owner_changed');
  };
  try { return await action(verify); }
  finally { if ((await owner(path))?.token === token) await rm(path, { recursive: true }); }
}
