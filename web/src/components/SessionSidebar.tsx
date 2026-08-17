import type { WebSessionMetadata } from '../api/session-types';

export function SessionSidebar({
  sessions,
  activeSessionId,
  selectedSessionId,
  search,
  onSearch,
  onNewSession,
  onSelect,
  onContinue,
  onSettings,
}: {
  sessions: WebSessionMetadata[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  onContinue: (sessionId: string) => void;
  onSettings: () => void;
}) {
  return (
    <aside className="workspace-sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">AF</span>
        <div><strong>AnyFusion</strong><small>Agent runtime</small></div>
      </div>
      <button className="new-session-button" onClick={onNewSession}>
        <span>＋</span> 新建会话
      </button>
      <label className="session-search">
        <span>⌕</span>
        <input
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder="搜索会话"
        />
      </label>
      <div className="session-section-label">
        <span>会话</span><small>{sessions.length}</small>
      </div>
      <div className="session-list">
        {sessions.map(session => {
          const active = session.id === activeSessionId;
          const selected = session.id === selectedSessionId;
          return (
            <button
              className="session-row"
              data-active={active}
              data-selected={selected}
              key={session.id}
              onClick={() => onSelect(session.id)}
            >
              <span className="session-row-status" />
              <span className="session-row-copy">
                <strong>{session.title}</strong>
                <small>{formatRelativeTime(session.updatedAt)}{active ? ' · 运行中' : ''}</small>
              </span>
              {!active && selected && (
                <span
                  className="continue-session"
                  role="button"
                  tabIndex={0}
                  onClick={event => {
                    event.stopPropagation();
                    onContinue(session.id);
                  }}
                >
                  继续此会话
                </span>
              )}
            </button>
          );
        })}
        {sessions.length === 0 && <div className="sidebar-empty">暂无历史会话</div>}
      </div>
      <button className="sidebar-settings" onClick={onSettings}>
        <span>设置</span>
      </button>
    </aside>
  );
}

function formatRelativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  return new Date(time).toLocaleDateString();
}
