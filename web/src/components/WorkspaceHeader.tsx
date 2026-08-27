import type { ThemePreference } from '../theme';
import type { WorkspaceSummary } from '../api/session-types';
import { ThemeControl } from './ThemeControl';

export type WorkspaceTab = 'conversation' | 'trajectory';

export function WorkspaceHeader({
  title,
  workspace,
  tab,
  connected,
  themePreference,
  onTabChange,
  onThemeChange,
}: {
  title: string;
  workspace: WorkspaceSummary | null;
  tab: WorkspaceTab;
  connected: boolean;
  themePreference: ThemePreference;
  onTabChange: (tab: WorkspaceTab) => void;
  onThemeChange: (preference: ThemePreference) => void;
}) {
  const workspacePath = workspace?.canonicalPath ?? null;
  return (
    <header className="workspace-header">
      <div className="workspace-title-block">
        <span className="workspace-kicker">AGENT WORKSPACE</span>
        <h1>{title}</h1>
        <div className="workspace-path" title={workspacePath ?? undefined}>
          <span>Workspace</span>
          <code>
            {workspacePath ?? '未设置 · 输入 /workspace /absolute/path'}
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
