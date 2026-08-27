import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WorkspaceCatalogStore } from '../workspace/workspace-catalog-store.js';
import {
  isValidWorkspaceId,
  normalizeWorkspaceDisplayName,
  WORKSPACE_CATALOG_VERSION,
  type WorkspaceCatalogFile,
  type WorkspaceId,
  type WorkspaceRecord,
} from '../workspace/workspace-types.js';

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export class FileWorkspaceCatalogStore implements WorkspaceCatalogStore {
  readonly rootDir: string;
  readonly catalogPath: string;
  readonly quarantineDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.catalogPath = join(this.rootDir, 'catalog.json');
    this.quarantineDir = join(this.rootDir, 'quarantine');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.rootDir, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineDir, { recursive: true, mode: 0o700 }),
    ]);
    try {
      await this.readCatalog();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.writeCatalog({
        version: WORKSPACE_CATALOG_VERSION,
        workspaces: [],
      });
    }
  }

  async readCatalog(): Promise<WorkspaceCatalogFile> {
    let raw: string;
    try {
      raw = await readFile(this.catalogPath, 'utf8');
    } catch (error) {
      throw error;
    }
    try {
      return parseCatalog(raw);
    } catch (error) {
      await this.quarantineCatalog();
      throw error;
    }
  }

  async writeCatalog(catalog: WorkspaceCatalogFile): Promise<void> {
    assertCatalog(catalog);
    await atomicWriteJson(this.catalogPath, catalog);
  }

  async findById(id: WorkspaceId): Promise<WorkspaceRecord | null> {
    if (!isValidWorkspaceId(id)) throw new Error(`Invalid Workspace id: ${id}`);
    return (await this.readCatalog()).workspaces.find(workspace => workspace.id === id) ?? null;
  }

  async findByCanonicalPath(path: string): Promise<WorkspaceRecord | null> {
    return (await this.readCatalog()).workspaces.find(
      workspace => workspace.canonicalPath === path,
    ) ?? null;
  }

  private async quarantineCatalog(): Promise<void> {
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
    try {
      await rename(
        this.catalogPath,
        join(this.quarantineDir, `catalog.${Date.now()}.${randomUUID()}.invalid.json`),
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function parseCatalog(raw: string): WorkspaceCatalogFile {
  const value = JSON.parse(raw) as unknown;
  assertCatalog(value);
  return value;
}

function assertCatalog(value: unknown): asserts value is WorkspaceCatalogFile {
  if (!isRecord(value)
    || value.version !== WORKSPACE_CATALOG_VERSION
    || !Array.isArray(value.workspaces)
    || !value.workspaces.every(isWorkspaceRecord)) {
    throw new Error('Invalid workspace catalog');
  }
  const activePaths = new Set<string>();
  for (const workspace of value.workspaces) {
    if (workspace.archived) continue;
    if (activePaths.has(workspace.canonicalPath)) {
      throw new Error(`Duplicate active Workspace canonical path: ${workspace.canonicalPath}`);
    }
    activePaths.add(workspace.canonicalPath);
  }
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !isValidWorkspaceId(value.id)) return false;
  if (typeof value.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(value.accountId)) return false;
  if (typeof value.displayName !== 'string') return false;
  try {
    if (normalizeWorkspaceDisplayName(value.displayName) !== value.displayName) return false;
  } catch {
    return false;
  }
  return typeof value.canonicalPath === 'string'
    && value.canonicalPath.length > 0
    && (value.availability === 'available' || value.availability === 'unavailable')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.createdByPrincipal === 'string'
    && typeof value.archived === 'boolean';
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
