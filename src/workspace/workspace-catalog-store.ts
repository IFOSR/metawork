import type {
  WorkspaceCatalogFile,
  WorkspaceId,
  WorkspaceRecord,
} from './workspace-types.js';

export interface WorkspaceCatalogStore {
  initialize(): Promise<void>;
  readCatalog(): Promise<WorkspaceCatalogFile>;
  writeCatalog(catalog: WorkspaceCatalogFile): Promise<void>;
  findById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  findByCanonicalPath(path: string): Promise<WorkspaceRecord | null>;
}
