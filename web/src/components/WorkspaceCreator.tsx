import { useEffect, useState } from 'react';
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
  onSelect: (path: string) => void;
}) {
  const [state, setState] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !http) return;
    let active = true;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory()
      .then(result => { if (active) setState(result); })
      .catch((cause: Error) => { if (active) setError(browseErrorLabel(cause.message)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, http]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const openPath = (path: string) => {
    if (!http || loading || disabled) return;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory(path)
      .then(result => setState(result))
      .catch((cause: Error) => setError(browseErrorLabel(cause.message)))
      .finally(() => setLoading(false));
  };

  const crumbs = state?.crumbs ?? [];

  return (
    <div className="workspace-creator-backdrop" onClick={onClose}>
      <div
        className="workspace-creator"
        role="dialog"
        aria-label="添加 Workspace"
        onClick={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="workspace-creator-kicker">ADD WORKSPACE</span>
            <h2>选择本机目录</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>关闭</button>
        </header>
        <nav className="workspace-creator-path" aria-label="当前目录">
          {crumbs.map(crumb => (
            <button
              key={crumb.path}
              type="button"
              onClick={() => openPath(crumb.path)}
            >
              {crumb.name}
            </button>
          ))}
        </nav>
        {error && <div className="result-banner result-error">{error}</div>}
        <div className="workspace-creator-list">
          {state?.parent && (
            <button
              type="button"
              className="workspace-creator-row"
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
              onClick={() => openPath(entry.path)}
            >
              <span aria-hidden="true">▸</span>
              <strong>{entry.name}</strong>
            </button>
          ))}
          {!loading && !error && state?.entries.length === 0 && !state.parent && (
            <div className="workspace-creator-empty">该目录下没有子目录</div>
          )}
          {loading && <div className="workspace-creator-empty">正在读取目录…</div>}
        </div>
        <footer>
          <code title={state?.path}>{state?.path ?? ''}</code>
          <button
            type="button"
            className="primary-button"
            disabled={!state || loading || disabled}
            onClick={() => { if (state) onSelect(state.path); }}
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
