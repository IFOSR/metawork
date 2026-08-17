export type WorkspaceTab = 'conversation' | 'trajectory';

export function WorkspaceHeader({
  title,
  tab,
  connected,
  revisionId,
  onTabChange,
}: {
  title: string;
  tab: WorkspaceTab;
  connected: boolean;
  revisionId: string | null;
  onTabChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <header className="workspace-header">
      <div className="workspace-title-block">
        <span className="workspace-kicker">AGENT WORKSPACE</span>
        <h1>{title}</h1>
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
        <span className="connection-state" data-connected={connected}>
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
        <span>{revisionId ? `rev ${revisionId}` : 'rev …'}</span>
      </div>
    </header>
  );
}
