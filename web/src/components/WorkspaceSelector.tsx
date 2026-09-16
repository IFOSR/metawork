import type { WorkspaceSummary } from '../api/session-types';

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  disabled = false,
  onSelect,
  onCreateWorkspace,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  disabled?: boolean;
  onSelect: (workspace: WorkspaceSummary) => void;
  onCreateWorkspace: () => void;
}) {
  const active = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  return (
    <div className="workspace-selector">
      <div className="workspace-selector-head">
        <label htmlFor="workspace-select">Workspace</label>
        <button
          type="button"
          className="workspace-create-button"
          aria-label="添加 Workspace"
          title="添加本机目录为 Workspace"
          disabled={disabled}
          onClick={onCreateWorkspace}
        >
          ＋
        </button>
      </div>
      <select
        id="workspace-select"
        value={activeWorkspaceId ?? ''}
        disabled={disabled}
        onChange={event => {
          const workspace = workspaces.find(item => item.id === event.target.value);
          if (workspace) onSelect(workspace);
        }}
      >
        {workspaces.length === 0 && <option value="">暂无 Workspace</option>}
        {workspaces.map(workspace => (
          <option
            key={workspace.id}
            value={workspace.id}
            disabled={workspace.availability !== 'available'}
          >
            {workspace.displayName}
            {workspace.availability === 'unavailable' ? ' · 不可用' : ''}
          </option>
        ))}
      </select>
      <div className="workspace-selector-path" title={active?.canonicalPath}>
        <span data-availability={active?.availability ?? 'unavailable'} />
        <code>{active?.canonicalPath ?? '点击 ＋ 添加本机目录'}</code>
      </div>
    </div>
  );
}
