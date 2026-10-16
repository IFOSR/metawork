import { useEffect, useRef, useState } from 'react';
import type { DocumentPreviewFormat } from '../../../src/delivery/document-preview-format';

/** The renderer has scripts but no origin privileges, cookies, API access or navigation grants. */
export function RichDocumentPreview({ format, content, name, artifactId }: {
  format: DocumentPreviewFormat; content: string; name: string; artifactId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let imageRequests = 0;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      if (event.data?.type === 'metawork-preview-escape') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
      if (event.data?.type === 'metawork-preview-image' && format === 'html') {
        const { requestId, reference } = event.data;
        const reply = (image: string | null) => frame.current?.contentWindow?.postMessage({
          type: 'metawork-preview-image-result', requestId, content: image,
        }, '*');
        if (!artifactId || ++imageRequests > 24 || typeof reference !== 'string' || reference.length > 2048) { reply(null); return; }
        void fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/preview-image?reference=${encodeURIComponent(reference)}`,
          { credentials: 'same-origin', signal: abort.signal })
          .then(async response => reply(response.ok ? (await response.json()).content : null))
          .catch(() => { if (!abort.signal.aborted) reply(null); });
      }
    };
    window.addEventListener('message', receive);
    return () => { abort.abort(); window.removeEventListener('message', receive); };
  }, [artifactId, format]);
  return <div className="rich-document-preview">
    {error && <p role="alert">阅读器加载失败，请重新打开预览或下载原文件。</p>}
    <iframe ref={frame} src="/document-preview.html" title={`${name} 预览`}
      sandbox="allow-scripts" referrerPolicy="no-referrer" onError={() => setError(true)}
      onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'metawork-preview', format, content, name }, '*')} />
  </div>;
}
