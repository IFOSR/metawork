import { useEffect, useRef, useState } from 'react';
import { loadImagePreview } from '../image-preview';

export function BudgetedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let controller: AbortController | null = null;
    let release: (() => void) | undefined;
    const clear = () => { controller?.abort(); controller = null; release?.(); release = undefined; setUrl(null); };
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) { clear(); return; }
      if (controller) return;
      const current = new AbortController(); controller = current;
      void loadImagePreview(src, current.signal).then(image => {
        if (current.signal.aborted) { image.release(); return; }
        release = image.release; setUrl(image.url);
      }).catch(() => { /* Keep the original-file link and explicit retry. */ });
    }, { rootMargin: '100px' });
    observer.observe(root.current!);
    return () => { observer.disconnect(); clear(); };
  }, [src, retry]);
  return <span ref={root} className="bounded-image-preview">
    {url ? <img className={className} src={url} alt={alt} loading="lazy" decoding="async"
      style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} />
      : <button type="button" onClick={() => setRetry(value => value + 1)}>预览图片：{alt}</button>}
    <a href={src} target="_blank" rel="noreferrer">查看原图</a>
  </span>;
}
