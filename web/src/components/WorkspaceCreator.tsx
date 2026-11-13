import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import { desktopBridge } from '../platform/services';

interface BrowseState {
  path: string;
  parent: string | null;
  crumbs: Array<{ name: string; path: string }>;
  entries: Array<{ name: string; path: string }>;
  root: string | null;
  nextCursor: string | null;
}

/**
 * Workspace 创建器：只能通过浏览本机目录选择，不接受手输路径。
 * 面包屑完全来自 Server 的结构化路径段，前端不解析操作系统路径。
 *
 * 当部署方配置了工作目录根（Server 返回 root），该根就是浏览与新建的唯一范围：
 * Server 在根位置不再返回上级目录，越界路径由 Server 拒绝，前端只负责呈现。
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
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const newNameRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setState(null);
    setLoading(true);
    setSelecting(false);
    setError(null);
    setCreating(false);
    setSubmitting(false);
    setNewName('');
    setCreateError(null);
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

  const busy = loading || selecting || submitting || disabled;
  const dismissDisabled = selecting || submitting || disabled;

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

  // 新建目录：成功后进入新目录，用户可以直接把它选为 Workspace。
  const submitNewDirectory = async () => {
    if (!http || !state || busy) return;
    const name = newName.trim();
    if (!name) { setCreateError('请输入目录名。'); return; }
    // submitting 只表示"请求在途"；creating 只表示"表单展开"。二者混用会把
    // 输入框和按钮一起禁用，表单一打开就死锁。
    setSubmitting(true);
    setCreateError(null);
    try {
      const created = await http.createWorkspaceDirectory(state.path, name);
      setNewName('');
      const result = await http.browseWorkspaceDirectory(created.directory.path);
      setState(result);
      setSubmitting(false);
    } catch (cause) {
      setSubmitting(false);
      setCreateError(createErrorLabel((cause as Error).message));
    }
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

  const loadMore = () => {
    if (!http || !state?.nextCursor || busy) return;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory(state.path, state.nextCursor)
      .then(result => setState(previous => previous && previous.path === result.path
        ? { ...result, entries: [...previous.entries, ...result.entries]
          .filter((entry, index, entries) => entries.findIndex(other => other.name === entry.name) === index) }
        : result))
      .catch((cause: Error) => setError(browseErrorLabel(cause.message)))
      .finally(() => setLoading(false));
  };

  const selectNative = async () => {
    if (busy) return;
    setSelecting(true); setError(null);
    try {
      const path = await desktopBridge()!.selectWorkspaceDirectory();
      if (!path) return;
      const selectionError = await onSelect(path);
      if (selectionError) setError(selectionError); else onClose();
    } catch { setError('目录选择未完成，请重试。'); }
    finally { setSelecting(false); }
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
          {createError && <div className="result-banner result-error">{createError}</div>}
        </div>
        <div className="workspace-creator-list">
          {creating && (
            <div className="workspace-creator-create">
              <input
                ref={newNameRef}
                type="text"
                value={newName}
                maxLength={128}
                placeholder="新目录名称"
                autoFocus
                disabled={submitting || disabled}
                onChange={event => setNewName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); void submitNewDirectory(); }
                  if (event.key === 'Escape') {
                    if (submitting || disabled) return;
                    event.preventDefault();
                    setCreating(false); setNewName(''); setCreateError(null);
                  }
                }}
              />
              <button type="button" disabled={submitting || disabled || !newName.trim()} onClick={() => void submitNewDirectory()}>创建</button>
              <button
                type="button"
                className="ghost-button"
                disabled={submitting || disabled}
                onClick={() => { setCreating(false); setNewName(''); setCreateError(null); }}
              >
                取消
              </button>
            </div>
          )}
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
          {!creating && (
            <button
              type="button"
              className="workspace-creator-row workspace-creator-row-create"
              disabled={busy}
              onClick={() => { setCreating(true); setCreateError(null); }}
            >
              <span aria-hidden="true">＋</span>
              <strong>新建目录</strong>
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
          {state?.nextCursor && (
            <button type="button" className="workspace-creator-row" disabled={busy} onClick={loadMore}>
              加载更多目录
            </button>
          )}
          {!loading && !error && !state?.nextCursor && state?.entries.length === 0 && (
            <div className="workspace-creator-empty">该目录下没有子目录，可直接新建</div>
          )}
          {loading && <div className="workspace-creator-empty">正在读取目录…</div>}
          {submitting && <div className="workspace-creator-empty">正在创建目录…</div>}
          {selecting && <div className="workspace-creator-empty">正在添加 Workspace…</div>}
        </div>
        <footer>
          <code title={state?.path}>{state?.path ?? ''}</code>
          {desktopBridge() && <button type="button" disabled={busy} onClick={() => void selectNative()}>在 Finder 中选择…</button>}
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

function createErrorLabel(code: string): string {
  if (code.includes('directory_name_invalid')) return '目录名不合法：不能包含路径分隔符，且不能为空。';
  if (code.includes('directory_exists')) return '同名目录已存在。';
  if (code.includes('directory_parent_not_found')) return '父目录不存在或已被移动。';
  if (code.includes('directory_parent_invalid')) return '父路径不是可用的目录。';
  if (code.includes('workspace_outside_root')) return '只能在工作目录根内新建目录。';
  if (code.includes('cookie_session_required')) return '当前会话无法新建目录，请重新登录。';
  return `新建目录失败：${code}`;
}
