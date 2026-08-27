import type { WorkspaceSummary } from '../api/session-types';

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  onSelect: (workspace: WorkspaceSummary) => void;
}) {
  const active = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null;
  return (
    <div className="workspace-selector">
      <label htmlFor="workspace-select">Workspace</label>
      <select
        id="workspace-select"
        value={activeWorkspaceId ?? ''}
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
        <code>{active?.canonicalPath ?? '从 Workspace 目录启动 MetaWork Web'}</code>
      </div>
    </div>
  );
}
