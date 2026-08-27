import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { WorkspaceConversationMigrator } from '../../src/workspace/workspace-conversation-migrator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-conversation-migration-'));
  roots.push(root);
  const conversationsRoot = join(root, 'conversations');
  const catalogRoot = join(root, 'workspace-catalog');
  await mkdir(join(conversationsRoot, 'records'), { recursive: true });
  return { root, conversationsRoot, catalogRoot };
}

function legacyMetadata(id: string, workspace: string | null) {
  return {
    id,
    plannerSessionId: id,
    accountId: 'local-default',
    title: id,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    archived: false,
    workspace: workspace === null ? null : {
      path: workspace,
      selectedAt: '2026-08-27T00:00:00.000Z',
      selectedByPrincipal: 'local:local-installation',
    },
  };
}

async function writeLegacy(
  conversationsRoot: string,
  entries: Array<{ id: string; workspace: string | null }>,
) {
  const conversations = entries.map(entry => legacyMetadata(entry.id, entry.workspace));
  await writeFile(join(conversationsRoot, 'catalog.json'), JSON.stringify({
    version: 2,
    conversations,
  }));
  for (const conversation of conversations) {
    await writeFile(
      join(conversationsRoot, 'records', `${conversation.id}.json`),
      JSON.stringify({ version: 2, conversation, turns: [] }),
    );
  }
}

describe('WorkspaceConversationMigrator', () => {
  it('groups equal canonical paths and remains idempotent', async () => {
    const value = await fixture();
    const repo = join(value.root, 'repo');
    await mkdir(repo);
    await writeLegacy(value.conversationsRoot, [
      { id: 'conv_one', workspace: repo },
      { id: 'conv_two', workspace: repo },
      { id: 'conv_unassigned', workspace: null },
    ]);
    let sequence = 0;
    const migrator = new WorkspaceConversationMigrator({
      accountId: 'local-default',
      conversationsRoot: value.conversationsRoot,
      workspaceCatalogRoot: value.catalogRoot,
      createWorkspaceId: () => `workspace_${++sequence}`,
      now: () => '2026-08-27T01:00:00.000Z',
    });

    await migrator.migrate();
    await migrator.migrate();

    const conversationStore = new FileConversationStore(value.conversationsRoot);
    const workspaceStore = new FileWorkspaceCatalogStore(value.catalogRoot);
    const one = await conversationStore.readConversation('conv_one');
    const two = await conversationStore.readConversation('conv_two');
    const unassigned = await conversationStore.readConversation('conv_unassigned');
    expect(one?.conversation.workspaceBinding?.workspaceId)
      .toBe(two?.conversation.workspaceBinding?.workspaceId);
    expect(unassigned?.conversation.workspaceBinding).toBeNull();
    expect((await workspaceStore.readCatalog()).workspaces).toHaveLength(1);
    expect(sequence).toBe(1);
  });

  it('preserves missing paths as unavailable Workspaces', async () => {
    const value = await fixture();
    await writeLegacy(value.conversationsRoot, [
      { id: 'conv_missing', workspace: join(value.root, 'missing') },
    ]);
    await new WorkspaceConversationMigrator({
      accountId: 'local-default',
      conversationsRoot: value.conversationsRoot,
      workspaceCatalogRoot: value.catalogRoot,
      createWorkspaceId: () => 'workspace_missing',
    }).migrate();

    const catalog = await new FileWorkspaceCatalogStore(value.catalogRoot).readCatalog();
    expect(catalog.workspaces[0]).toMatchObject({
      id: 'workspace_missing',
      availability: 'unavailable',
      canonicalPath: join(value.root, 'missing'),
    });
  });

  it('leaves the v2 authority intact when preparation fails', async () => {
    const value = await fixture();
    const repo = join(value.root, 'repo');
    await mkdir(repo);
    await writeLegacy(value.conversationsRoot, [{ id: 'conv_one', workspace: repo }]);
    const before = await readFile(join(value.conversationsRoot, 'catalog.json'), 'utf8');
    const migrator = new WorkspaceConversationMigrator({
      accountId: 'local-default',
      conversationsRoot: value.conversationsRoot,
      workspaceCatalogRoot: value.catalogRoot,
      createWorkspaceId: () => {
        throw new Error('injected failure');
      },
    });

    await expect(migrator.migrate()).rejects.toThrow('injected failure');
    expect(await readFile(join(value.conversationsRoot, 'catalog.json'), 'utf8')).toBe(before);
  });
});
