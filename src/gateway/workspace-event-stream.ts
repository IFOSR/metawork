export function workspaceEventStreamId(workspaceId: string): string {
  return `workspace_directory_${workspaceId}`;
}
