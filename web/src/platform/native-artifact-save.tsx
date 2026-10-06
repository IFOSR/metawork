import { useState } from 'react';
import { desktopBridge } from './services';

export function NativeArtifactSave({ artifactId }: { artifactId: string }) {
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { setDownload(await desktopBridge()!.saveArtifact(artifactId)); }
    catch { setError('保存失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <span className="native-artifact-save">
    <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '另存为…'}</button>
    {download && <button type="button" onClick={() => {
      void desktopBridge()!.showDownloadedArtifact(download).catch(() => setError('文件位置不可用。'));
    }}>在 Finder 中显示</button>}
    {error && <span role="alert">{error}</span>}
  </span>;
}
