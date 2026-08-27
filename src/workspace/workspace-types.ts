export const WORKSPACE_CATALOG_VERSION = 1;

const WORKSPACE_ID_PATTERN = /^workspace_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_DISPLAY_NAME_LENGTH = 120;

export type WorkspaceId = string;

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly accountId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly availability: 'available' | 'unavailable';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByPrincipal: string;
  readonly archived: boolean;
}

export interface WorkspaceCatalogFile {
  readonly version: typeof WORKSPACE_CATALOG_VERSION;
  readonly workspaces: WorkspaceRecord[];
}

export function isValidWorkspaceId(value: string): value is WorkspaceId {
  return WORKSPACE_ID_PATTERN.test(value);
}

export function normalizeWorkspaceDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error('Invalid Workspace display name');
  }
  return normalized;
}
