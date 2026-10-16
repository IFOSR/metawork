import { useState } from 'react';
import { desktopBridge } from './services';

export function NativeArtifactSave({ artifactId, attachment }: {
  artifactId?: string; attachment?: { conversationId: string; attachmentId: string };
}) {
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const bridge = desktopBridge()!;
      if (attachment) {
        if (!bridge.saveAttachment) { setError('请更新桌面应用后保存附件。'); return; }
        setDownload(await bridge.saveAttachment(attachment.conversationId, attachment.attachmentId));
      } else setDownload(await bridge.saveArtifact(artifactId!));
    }
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
