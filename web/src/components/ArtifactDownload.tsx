import { useEffect, useId, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { ArtifactProjection } from '../api/session-types';
import { desktopBridge } from '../platform/services';
import { NativeArtifactSave } from '../platform/native-artifact-save';

export function ArtifactDownload({ http, artifact }: { http: HttpClient | null; artifact: ArtifactProjection }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const bridge = desktopBridge();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  if (!bridge && !http) return null;
  if (artifact.previewKind !== 'markdown') {
    return bridge ? <NativeArtifactSave artifactId={artifact.artifactId} /> : <a
      href={http!.artifactDownloadUrl(artifact.artifactId)} download={artifact.displayName}
      className="artifact-drawer-download" title="下载原文件" aria-label="下载原文件">⬇</a>;
  }

  const save = async (format: 'original' | 'pdf') => {
    if (busy) return;
    setBusy(true); setError(null); setOpen(false); toggle.current?.focus();
    try {
      if (bridge) {
        const result = await bridge.saveArtifact(artifact.artifactId, format);
        if (result) setDownload(result);
      } else if (http && format === 'pdf') {
        const blob = await http.downloadArtifactPdf(artifact.artifactId);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${artifact.displayName.replace(/\.(?:md|markdown)$/iu, '')}.pdf`;
        document.body.append(link); link.click(); link.remove();
        // Let browsers consume the Blob before releasing it.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch { setError(format === 'pdf' ? 'PDF 导出失败，请重试。' : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };

  return <div className="artifact-download" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation(); setOpen(false); toggle.current?.focus();
    }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={toggle} type="button" className="artifact-download-toggle" disabled={busy}
      aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
      {busy ? '正在导出…' : '下载 ▾'}
    </button>
    {busy && <span className="sr-only" role="status">正在生成并保存文件，请稍候。</span>}
    {open && <div className="artifact-download-options" id={menuId} role="group" aria-label="下载格式">
      {bridge ? <button type="button" onClick={() => void save('original')}>Markdown（原文）<small>.md</small></button>
        : <a href={http!.artifactDownloadUrl(artifact.artifactId)} download={artifact.displayName}
          onClick={() => { setOpen(false); setError(null); toggle.current?.focus(); }}>Markdown（原文）<small>.md</small></a>}
      <button type="button" onClick={() => void save('pdf')}>PDF 文档<small>.pdf</small></button>
    </div>}
    {(error || download) && <div className="artifact-download-feedback">
      {error && <span role="alert">{error}</span>}
      {download && <button type="button" onClick={() => {
        void bridge?.showDownloadedArtifact(download).catch(() => setError('文件位置不可用。'));
      }}>在 Finder 中显示</button>}
    </div>}
  </div>;
}
