import type { ThemePreference } from '../theme';
import type { WorkspaceSummary } from '../api/session-types';
import { ThemeControl } from './ThemeControl';

export type WorkspaceTab = 'conversation' | 'trajectory' | 'billing';

export function WorkspaceHeader({
  title,
  workspace,
  tab,
  connected,
  themePreference,
  onTabChange,
  onThemeChange,
  onToggleSidebar,
  sidebarHidden,
}: {
  title: string;
  workspace: WorkspaceSummary | null;
  tab: WorkspaceTab;
  connected: boolean;
  themePreference: ThemePreference;
  onTabChange: (tab: WorkspaceTab) => void;
  onThemeChange: (preference: ThemePreference) => void;
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
}) {
  const workspacePath = workspace?.canonicalPath ?? null;
  return (
    <header className="workspace-header">
      <div className="workspace-title-block">
        {onToggleSidebar && <button className="sidebar-toggle" onClick={onToggleSidebar} aria-expanded={!sidebarHidden}
          aria-label={sidebarHidden ? '显示侧栏' : '隐藏侧栏'}>☰</button>}
        <span className="workspace-kicker">AGENT WORKSPACE</span>
        <h1>{title}</h1>
        <div className="workspace-path" title={workspacePath ?? undefined}>
          <span>Workspace</span>
          <code>
            {workspacePath ?? '未设置 · 点击左侧 ＋ 添加本机目录'}
          </code>
        </div>
      </div>
      <nav className="workspace-tabs" aria-label="会话视图">
        <button data-active={tab === 'conversation'} onClick={() => onTabChange('conversation')}>
          对话
        </button>
        <button data-active={tab === 'trajectory'} onClick={() => onTabChange('trajectory')}>
          轨迹
        </button>
        <button data-active={tab === 'billing'} onClick={() => onTabChange('billing')}>
          账单
        </button>
      </nav>
      <div className="workspace-runtime">
        <ThemeControl value={themePreference} onChange={onThemeChange} />
        <span className="connection-state" data-connected={connected}>
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>
    </header>
  );
}
