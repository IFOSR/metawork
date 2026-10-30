import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { boundedPathSegment } from '../utils/bounded-path-segment.js';
import type { ArtifactVersion } from '../storage/artifact-version-repo.js';
import { assertGitPath, assertOid } from '../execution/workspace-git-service.js';

const execFileAsync = promisify(execFile);

/** The locator never supplies a filesystem root. Only the authenticated account's object root does. */
export function readGitArtifact(version:ArtifactVersion,objectRoot:string,maxBytes=1024**3):Buffer {
  const commit=version.gitCommit,path=version.gitRelativePath;
  if(!commit||!path)throw new Error('git_artifact_reference_missing');
  assertOid(commit);assertGitPath(path);
  if(version.objectUri!==`git-object:${version.workspaceId}:${commit}:${encodeURIComponent(path)}`)throw new Error('git_artifact_locator_mismatch');
  const repository=join(dirname(dirname(dirname(objectRoot))),'workspace-git',boundedPathSegment(version.workspaceId,{prefix:'w'}),'repository.git');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0'});
  const git=(args:string[],limit=1024*1024)=>execFileSync('git',['-c','core.hooksPath=/dev/null','--git-dir',repository,...args],{env,timeout:120000,maxBuffer:limit,stdio:['ignore','pipe','pipe']});
  const pinned=git(['rev-parse','--verify',`refs/metawork/artifacts/${version.artifactVersionId}`]).toString().trim();
  if(pinned!==commit)throw new Error('git_artifact_pin_mismatch');
  const row=git(['ls-tree','-z',commit,'--',path]).toString('utf8').split('\0').filter(Boolean);
  if(row.length!==1)throw new Error('git_artifact_file_missing');
  const tab=row[0].indexOf('\t');const [mode,type,oid]=row[0].slice(0,tab).split(' ');
  if(!['100644','100755'].includes(mode)||type!=='blob'||row[0].slice(tab+1)!==path)throw new Error('git_artifact_not_regular_file');
  const size=Number(git(['cat-file','-s',oid]).toString());
  if(!Number.isSafeInteger(size)||size<0||size>maxBytes||size!==version.byteLength)throw new Error('git_artifact_size_limit_or_mismatch');
  const bytes=git(['cat-file','blob',oid],Math.max(1,size+1));
  if(createHash('sha256').update(bytes).digest('hex')!==version.contentHash.replace(/^sha256:/u,''))throw new Error('git_artifact_digest_mismatch');
  return bytes;
}

/** Async bounded reader used by HTTP/download paths. Metadata is checked before
 * opening the blob stream, and stdout is never allowed to grow beyond the
 * caller's cap. This keeps a large Git object out of an unbounded Buffer. */
export async function readGitArtifactAsync(version: ArtifactVersion, objectRoot: string, maxBytes = 1024 ** 3): Promise<Buffer> {
  const commit = version.gitCommit;
  const path = version.gitRelativePath;
  if (!commit || !path) throw new Error('git_artifact_reference_missing');
  assertOid(commit); assertGitPath(path);
  if (version.objectUri !== `git-object:${version.workspaceId}:${commit}:${encodeURIComponent(path)}`) throw new Error('git_artifact_locator_mismatch');
  const repository = join(dirname(dirname(dirname(objectRoot))), 'workspace-git', boundedPathSegment(version.workspaceId, { prefix: 'w' }), 'repository.git');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = async (args: string[]): Promise<Buffer> => {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', repository, ...args], {
      env, timeout: 120_000, maxBuffer: Math.min(maxBytes + 1024, 8 * 1024 * 1024), encoding: 'buffer',
    });
    return result.stdout as Buffer;
  };
  const pinned = (await git(['rev-parse', '--verify', `refs/metawork/artifacts/${version.artifactVersionId}`])).toString().trim();
  if (pinned !== commit) throw new Error('git_artifact_pin_mismatch');
  const row = (await git(['ls-tree', '-z', commit, '--', path])).toString('utf8').split('\0').filter(Boolean);
  if (row.length !== 1) throw new Error('git_artifact_file_missing');
  const tab = row[0]!.indexOf('\t');
  const [mode, type, oid] = row[0]!.slice(0, tab).split(' ');
  if (!['100644', '100755'].includes(mode!) || type !== 'blob' || row[0]!.slice(tab + 1) !== path) throw new Error('git_artifact_not_regular_file');
  const size = Number((await git(['cat-file', '-s', oid!])).toString());
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || size !== version.byteLength) throw new Error('git_artifact_size_limit_or_mismatch');
  const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', repository, 'cat-file', 'blob', oid!], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let total = 0;
  const stderr: Buffer[] = [];
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  for await (const chunk of child.stdout) {
    const bytes = Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > maxBytes) {
      child.kill('SIGKILL');
      await exitPromise.catch(() => 1);
      throw new Error('git_artifact_size_limit_or_mismatch');
    }
    chunks.push(bytes);
  }
  const exitCode = await exitPromise;
  if (exitCode !== 0) throw new Error(stderr.join('').slice(0, 2000) || 'git_artifact_read_failed');
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== version.contentHash.replace(/^sha256:/u, '')) throw new Error('git_artifact_digest_mismatch');
  return bytes;
}
