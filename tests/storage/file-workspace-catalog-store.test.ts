import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import {
  WORKSPACE_CATALOG_VERSION,
  type WorkspaceCatalogFile,
  type WorkspaceRecord,
} from '../../src/workspace/workspace-types.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; store: FileWorkspaceCatalogStore }> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-workspace-catalog-'));
  roots.push(root);
  const store = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
  await store.initialize();
  return { root, store };
}

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'workspace_one',
    accountId: 'local-default',
    displayName: 'repo',
    canonicalPath: '/repo',
    availability: 'available',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    createdByPrincipal: 'local:user',
    archived: false,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('FileWorkspaceCatalogStore', () => {
  it('initializes a versioned empty catalog with private permissions', async () => {
    const { root, store } = await fixture();
    expect(await store.readCatalog()).toEqual({
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: [],
    });
    expect((await stat(join(root, 'workspace-catalog'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'workspace-catalog', 'catalog.json'))).mode & 0o777).toBe(0o600);
  });

  it('atomically round-trips available and unavailable records', async () => {
    const { store } = await fixture();
    const catalog: WorkspaceCatalogFile = {
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: [
        workspace(),
        workspace({
          id: 'workspace_missing',
          canonicalPath: '/missing/repo',
          availability: 'unavailable',
          archived: true,
        }),
      ],
    };
    await store.writeCatalog(catalog);

    expect(await store.readCatalog()).toEqual(catalog);
    expect(await store.findById('workspace_missing')).toEqual(catalog.workspaces[1]);
    expect(await store.findByCanonicalPath('/missing/repo')).toEqual(catalog.workspaces[1]);
  });

  it('rejects duplicate active canonical paths and traversal ids', async () => {
    const { store } = await fixture();
    await expect(store.writeCatalog({
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: [
        workspace(),
        workspace({ id: 'workspace_two' }),
      ],
    })).rejects.toThrow(/canonical path/u);
    await expect(store.writeCatalog({
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: [workspace({ id: '../escape' })],
    })).rejects.toThrow(/workspace catalog/u);
  });

  it('quarantines an invalid catalog instead of accepting records', async () => {
    const { root, store } = await fixture();
    const catalogPath = join(root, 'workspace-catalog', 'catalog.json');
    await chmod(catalogPath, 0o600);
    await writeFile(catalogPath, '{"version":1,"workspaces":[{"id":"../escape"}]}\n');

    await expect(store.readCatalog()).rejects.toThrow(/workspace catalog/u);
    expect(await readdir(join(root, 'workspace-catalog', 'quarantine'))).toHaveLength(1);
    await expect(readFile(catalogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
