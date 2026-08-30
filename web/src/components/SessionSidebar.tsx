import type { WebSessionMetadata, WorkspaceSummary } from '../api/session-types';
import { resolveSessionActivity } from '../session-activity';
import { WorkspaceSelector } from './WorkspaceSelector';

export function SessionSidebar({
  sessions,
  workspaces,
  activeWorkspaceId,
  activeSessionId,
  runningSessionId,
  selectedSessionId,
  search,
  onSearch,
  onSelectWorkspace,
  onNewSession,
  onSelect,
  onDeleteSession,
  onClearSessions,
  onSettings,
}: {
  sessions: WebSessionMetadata[];
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  runningSessionId: string | null;
  selectedSessionId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClearSessions: () => void;
  onSettings: () => void;
}) {
  return (
    <aside className="workspace-sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">MW</span>
        <div><strong>MetaWork</strong><small>Agent runtime</small></div>
      </div>
      <WorkspaceSelector
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelect={onSelectWorkspace}
      />
      <button
        className="new-session-button"
        onClick={onNewSession}
        disabled={!activeWorkspaceId}
      >
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
        <span>会话</span>
        <small>{sessions.length}</small>
        {sessions.length > 0 && (
          <button
            className="clear-sessions"
            title="清空除当前会话外的全部历史"
            onClick={onClearSessions}
          >
            清空
          </button>
        )}
      </div>
      <div className="session-list">
        {sessions.map(session => {
          const active = session.id === activeSessionId;
          const running = session.id === runningSessionId;
          const selected = session.id === selectedSessionId;
          const activity = resolveSessionActivity(session.activity?.state, running);
          return (
            <button
              className="session-row"
              data-active={active}
              data-running={running || undefined}
              data-activity={activity}
              data-selected={selected}
              key={session.id}
              onClick={() => onSelect(session.id)}
            >
              <span className="session-row-status" />
              <span className="session-row-copy">
                <strong>{session.title}</strong>
                <small>
                  {formatRelativeTime(session.updatedAt)}
                  {' · '}
                  {activityLabel(activity)}
                  {active ? ' · 当前' : ''}
                </small>
              </span>
              {!active && (
                <span
                  className="delete-session"
                  role="button"
                  aria-label={`删除会话 ${session.title}`}
                  tabIndex={0}
                  onClick={event => {
                    event.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onDeleteSession(session.id);
                    }
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
        {sessions.length === 0 && (
          <div className="sidebar-empty">
            {activeWorkspaceId ? '当前 Workspace 暂无会话' : '请先选择 Workspace'}
          </div>
        )}
      </div>
      <button className="sidebar-settings" onClick={onSettings}>
        <span>设置</span>
      </button>
    </aside>
  );
}

function activityLabel(
  state: NonNullable<WebSessionMetadata['activity']>['state'],
): string {
  return {
    idle: '空闲',
    planning: '规划中',
    executing: '执行中',
    waiting: '等待中',
    blocked: '已阻塞',
  }[state];
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
