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
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4.5v11M4.5 10h11" />
          </svg>
        </button>
      </div>
      <select
        id="workspace-select"
        value={active?.id ?? ''}
        disabled={disabled}
        onChange={event => {
          const workspace = workspaces.find(item => item.id === event.target.value);
          if (workspace) onSelect(workspace);
        }}
      >
        {!active && (
          <option value="" disabled>
            {workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}
          </option>
        )}
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
        <code>{active?.canonicalPath ?? '点击添加按钮选择本机目录'}</code>
      </div>
    </div>
  );
}
