import { useEffect, useState } from 'react';
import type { WsClient } from '../api/ws';
import type { WorkspaceMergeSummary, WorkspaceMergeJob, WorkspaceConflictVersions } from '../../../src/workspace/workspace-git-contracts';
import type { GatewayMergeConflictAction } from '../../../src/gateway/client-protocol';

const LABELS: Record<WorkspaceMergeSummary['state'], string> = {
  queued: '等待写回 Workspace', preparing: '正在核对 Workspace', merging: '正在合并', conflicted: '工作已完成，文件冲突需要处理',
  writing: '正在写回 Workspace', recovering: '写回暂未完成，可重试', delivered: '已写回 Workspace', cancelled: '已取消写回，成果仍保留',
};
const SIDES = {base: '共同基础版本', main: 'Workspace 当前版本', session: '本会话版本'};

export function WorkspaceMergeCard({ws, workspaceId, summary, refresh}: {
  ws: WsClient; workspaceId: string; summary: WorkspaceMergeSummary; refresh(): void;
}) {
  const [job, setJob] = useState<WorkspaceMergeJob | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [versions, setVersions] = useState<WorkspaceConflictVersions | null>(null);
  const [actions, setActions] = useState<Record<string, GatewayMergeConflictAction>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setJob(null); setPaths([]); setActions({}); setVersions(null); setNextOffset(null); }, [summary.jobId, summary.conflictVersion]);
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function load(offset = 0) {
    const response = await ws.workspaceCommand({kind: 'get_workspace_merge_conflict', workspaceId, jobId: summary.jobId, offset});
    setJob(response.job ?? null); setPaths(old => offset ? [...old, ...(response.paths ?? [])] : response.paths ?? []);
    setNextOffset(response.nextOffset ?? null);
  }
  async function download(side: WorkspaceConflictVersions['versions'][number]) {
    if (!versions) return;
    let current = side; const chunks: Uint8Array[] = [];
    do {
      const bytes = Uint8Array.from(atob(current.contentBase64), value => value.charCodeAt(0)); chunks.push(bytes);
      if (current.nextOffset === null) break;
      const response = await ws.workspaceCommand({kind: 'get_workspace_conflict_versions', workspaceId, jobId: summary.jobId,
        conflictVersion: versions.conflictVersion, path: versions.path, offset: current.nextOffset});
      const next = response.versions?.versions.find(value => value.side === side.side);
      if (!next || next.commit !== side.commit) throw new Error('文件版本已变化，请重新查看。');
      current = next;
    } while (true);
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[]));
    const link = document.createElement('a'); link.href = url; link.download = `${side.side}-${versions.path.split('/').pop()}`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="workspace-changes-card" aria-label="Workspace 写回状态" aria-busy={busy}>
    <p role="status">{LABELS[summary.state]}{summary.aheadCount > 0 && `（前面还有 ${summary.aheadCount} 项）`}</p>
    {summary.totalFiles > 0 && <p>{summary.completedFiles} / {summary.totalFiles} 个文件已写回</p>}
    {summary.error && <p>{summary.error}</p>}
    {summary.state === 'conflicted' && <>
      <button type="button" disabled={busy} onClick={() => void perform(() => load())}>查看冲突文件</button>
      <ul>{paths.map(path => <li key={path}>
        <code>{path}</code>{' '}
        <button type="button" disabled={busy} onClick={() => void perform(async () => {
          const response = await ws.workspaceCommand({kind: 'get_workspace_conflict_versions', workspaceId, jobId: summary.jobId, conflictVersion: job!.conflictVersion, path});
          setVersions(response.versions ?? null);
        })}>查看版本</button>{' '}
        <label>处理方式 <select aria-label={`${path} 的处理方式`} value={actions[path]?.action ?? ''} disabled={busy}
          onChange={event => setActions(old => ({...old, [path]: {path, action: event.target.value as GatewayMergeConflictAction['action']}}))}>
          <option value="">请选择</option><option value="keep_main">保留 Workspace 版本</option>
          <option value="take_session">使用会话版本</option><option value="save_as">会话版本另存为</option>
          <option value="resolved_file">上传解决后的文件</option>
        </select></label>
        {actions[path]?.action === 'save_as' && <label>新文件相对路径 <input value={actions[path]?.newPath ?? ''} disabled={busy}
          onChange={event => setActions(old => ({...old, [path]: {...old[path], newPath: event.target.value}}))} /></label>}
        {actions[path]?.action === 'resolved_file' && <label>解决后的文件 <input type="file" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          void perform(async () => {
            if (file.size > 512 * 1024) throw new Error('手工解决文件最多 512 KiB；较大文件请使用另存为。');
            const bytes = new Uint8Array(await file.arrayBuffer()); let encoded = '';
            for (const byte of bytes) encoded += String.fromCharCode(byte);
            setActions(old => ({...old, [path]: {...old[path], contentBase64: btoa(encoded)}}));
          });
        }} /></label>}
      </li>)}</ul>
      {nextOffset !== null && <button type="button" disabled={busy} onClick={() => void perform(() => load(nextOffset))}>加载更多冲突</button>}
      {job && paths.length > 0 && <button type="button" disabled={busy || nextOffset !== null || paths.some(path => !actions[path]?.action)}
        onClick={() => void perform(async () => { await ws.workspaceCommand({kind: 'resolve_workspace_merge_conflict', workspaceId,
          jobId: summary.jobId, rowVersion: job.rowVersion, conflictVersion: job.conflictVersion, actions: paths.map(path => actions[path])}); setPaths([]); setVersions(null); })}>应用所选处理方式</button>}
    </>}
    {versions && <div aria-label={`${versions.path} 的版本`}><p><code>{versions.path}</code></p>
      {versions.versions.map(version => <details key={version.side}><summary>{SIDES[version.side]}（{version.exists ? `${version.byteLength} 字节` : '文件不存在'}）</summary>
        {version.text !== null && <pre style={{overflowX: 'auto', maxHeight: '20rem'}}>{version.text}</pre>}
        {version.exists && <button type="button" disabled={busy} onClick={() => void perform(() => download(version))}>下载此版本</button>}
      </details>)}
    </div>}
    {summary.state === 'recovering' && <button type="button" disabled={busy} onClick={() => void perform(() => ws.workspaceCommand({kind: 'retry_workspace_merge', workspaceId, jobId: summary.jobId, rowVersion: summary.rowVersion}))}>重试写回</button>}
    {!['delivered', 'cancelled'].includes(summary.state) && <details><summary>取消写回</summary>
      <p>会话成果会保留；已经写入的文件会保留在 Workspace 中。</p>
      <button type="button" disabled={busy} onClick={() => void perform(() => ws.workspaceCommand({kind: 'cancel_workspace_merge', workspaceId,
        jobId: summary.jobId, rowVersion: summary.rowVersion, partialDecision: 'keep_partial'}))}>确认取消并保留已写入文件</button>
    </details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
