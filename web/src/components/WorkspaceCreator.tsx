import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';

interface BrowseState {
  path: string;
  parent: string | null;
  crumbs: Array<{ name: string; path: string }>;
  entries: Array<{ name: string; path: string }>;
}

/**
 * Workspace 创建器：只能通过浏览本机目录选择，不接受手输路径。
 * 面包屑完全来自 Server 的结构化路径段，前端不解析操作系统路径。
 */
export function WorkspaceCreator({
  http,
  open,
  disabled = false,
  onClose,
  onSelect,
}: {
  http: HttpClient | null;
  open: boolean;
  disabled?: boolean;
  onClose: () => void;
  onSelect: (path: string) => Promise<string | null>;
}) {
  const [state, setState] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setState(null);
    setLoading(true);
    setSelecting(false);
    setError(null);
    if (!http) {
      setLoading(false);
      setError('Workspace 服务尚未就绪，请稍后重试。');
      return;
    }
    void http.browseWorkspaceDirectory()
      .then(result => { if (active) setState(result); })
      .catch((cause: Error) => { if (active) setError(browseErrorLabel(cause.message)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, http]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  const busy = loading || selecting || disabled;
  const dismissDisabled = selecting || disabled;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dismissDisabled) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), '
          + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, dismissDisabled]);

  if (!open) return null;

  const openPath = (path: string) => {
    if (!http || busy) return;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory(path)
      .then(result => setState(result))
      .catch((cause: Error) => setError(browseErrorLabel(cause.message)))
      .finally(() => setLoading(false));
  };

  const selectCurrentPath = () => {
    if (!state || busy) return;
    setSelecting(true);
    setError(null);
    void onSelect(state.path)
      .then(selectionError => {
        if (selectionError) {
          setError(selectionError);
          setSelecting(false);
          return;
        }
        setSelecting(false);
        onClose();
      })
      .catch(cause => {
        setError(`Workspace 创建失败：${(cause as Error).message}`);
        setSelecting(false);
      });
  };

  const crumbs = state?.crumbs ?? [];

  return (
    <div
      className="workspace-creator-backdrop"
      onClick={() => { if (!dismissDisabled) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="workspace-creator"
        role="dialog"
        aria-modal="true"
        aria-label="添加 Workspace"
        aria-busy={loading || selecting}
        onClick={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="workspace-creator-kicker">ADD WORKSPACE</span>
            <h2>选择本机目录</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="ghost-button"
            disabled={dismissDisabled}
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        <nav className="workspace-creator-path" aria-label="当前目录">
          {crumbs.map(crumb => (
            <button
              key={crumb.path}
              type="button"
              disabled={busy}
              onClick={() => openPath(crumb.path)}
            >
              {crumb.name}
            </button>
          ))}
        </nav>
        <div className="workspace-creator-status" aria-live="polite">
          {error && <div className="result-banner result-error">{error}</div>}
        </div>
        <div className="workspace-creator-list">
          {state?.parent && (
            <button
              type="button"
              className="workspace-creator-row"
              disabled={busy}
              onClick={() => openPath(state.parent!)}
            >
              <span aria-hidden="true">↰</span>
              <strong>.. 上级目录</strong>
            </button>
          )}
          {state?.entries.map(entry => (
            <button
              type="button"
              className="workspace-creator-row"
              key={entry.name}
              disabled={busy}
              onClick={() => openPath(entry.path)}
            >
              <span aria-hidden="true">▸</span>
              <strong>{entry.name}</strong>
            </button>
          ))}
          {!loading && !error && state?.entries.length === 0 && (
            <div className="workspace-creator-empty">该目录下没有子目录</div>
          )}
          {loading && <div className="workspace-creator-empty">正在读取目录…</div>}
          {selecting && <div className="workspace-creator-empty">正在添加 Workspace…</div>}
        </div>
        <footer>
          <code title={state?.path}>{state?.path ?? ''}</code>
          <button
            type="button"
            className="primary-button"
            disabled={!state || busy}
            onClick={selectCurrentPath}
          >
            选择此目录
          </button>
        </footer>
      </div>
    </div>
  );
}

function browseErrorLabel(code: string): string {
  if (code.includes('browse_path_forbidden')) return '没有权限读取该目录。';
  if (code.includes('browse_path_not_found')) return '目录不存在或已被移动。';
  if (code.includes('browse_path_invalid')) return '该路径不是可用的目录。';
  return `读取目录失败：${code}`;
}
