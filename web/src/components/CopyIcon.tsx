import { useEffect, useRef, useState } from 'react';

/** Also works on LAN HTTP, where the asynchronous Clipboard API is unavailable. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the user-gesture fallback. */ }
  }
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(input);
  try {
    input.focus({ preventScroll: true }); input.select();
    if (!document.execCommand('copy')) throw new Error('copy_failed');
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges(); ranges.forEach(range => selection?.addRange(range));
  }
}

export function CopyIcon({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef(0);
  useEffect(() => {
    setStatus('idle');
    return () => { request.current++; clearTimeout(reset.current); };
  }, [text]);
  const feedback = status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试或选择文字复制' : label;
  return <button type="button" className="message-copy-icon" aria-label={label} title={feedback}
    data-copy-status={status} onClick={async () => {
      const current = ++request.current;
      clearTimeout(reset.current);
      setStatus('idle');
      try { await copyText(text); if (current === request.current) setStatus('copied'); }
      catch { if (current === request.current) setStatus('failed'); }
      if (current === request.current) reset.current = setTimeout(() => setStatus('idle'), 2000);
    }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === 'copied' ? <path d="m5 12 4 4L19 6" />
        : status === 'failed' ? <><path d="m7 7 10 10M17 7 7 17" /></>
          : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
    </svg>
    <span className="message-copy-status" role="status">{status === 'idle' ? '' : feedback}</span>
  </button>;
}
