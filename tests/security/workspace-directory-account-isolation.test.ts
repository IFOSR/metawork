import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import type { ConversationMetadata } from '../../src/session/conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';
import type { WorkspaceRecord } from '../../src/workspace/workspace-types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Workspace Directory account isolation', () => {
  it('fails closed for foreign-account Workspaces and Conversations', async () => {
    const value = await fixture();

    await expect(value.directory.listWorkspaces('local:allowed')).resolves.toEqual([
      value.workspaceA,
    ]);
    await expect(value.directory.listConversations(
      value.workspaceB.id,
      'local:allowed',
    )).rejects.toThrow('workspace_unauthorized');
    await expect(value.directory.createConversation(
      value.workspaceB.id,
      'local:allowed',
    )).rejects.toThrow('workspace_unauthorized');
    await expect(value.directory.resolveConversationWorkspace(
      value.conversationB.id,
      'local:allowed',
    )).resolves.toBeNull();
    await expect(value.directory.isConversationInWorkspace(
      value.workspaceB.id,
      value.conversationB.id,
      'local:allowed',
    )).resolves.toBe(false);
  });

  it('does not disclose Workspace paths or Conversation metadata to unauthorized Principals', async () => {
    const value = await fixture();

    await expect(value.directory.listWorkspaces('local:denied')).resolves.toEqual([]);
    await expect(value.directory.listConversations(
      value.workspaceA.id,
      'local:denied',
    )).rejects.toThrow('workspace_unauthorized');
    await expect(value.directory.resolveConversationWorkspace(
      value.conversationA.id,
      'local:denied',
    )).resolves.toBeNull();
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-account-isolation-'));
  roots.push(root);
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  await Promise.all([mkdir(repoA), mkdir(repoB)]);
  const workspaceCatalog = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
  const conversationStore = new FileConversationStore(join(root, 'conversations'));
  await Promise.all([workspaceCatalog.initialize(), conversationStore.initialize()]);
  const workspaceA = workspace('workspace_a', 'account-a', repoA);
  const workspaceB = workspace('workspace_b', 'account-b', repoB);
  await workspaceCatalog.writeCatalog({
    version: 1,
    workspaces: [workspaceA, workspaceB],
  });
  const conversationA = conversation('conv_a', 'account-a', workspaceA.id);
  const conversationB = conversation('conv_b', 'account-b', workspaceB.id);
  await Promise.all([
    conversationStore.writeConversation({
      version: 3,
      conversation: conversationA,
      turns: [],
    }),
    conversationStore.writeConversation({
      version: 3,
      conversation: conversationB,
      turns: [],
    }),
  ]);
  await conversationStore.writeCatalog({
    version: 3,
    conversations: [conversationA, conversationB],
  });
  const directory = new WorkspaceDirectoryService({
    accountId: 'account-a',
    workspaceCatalog,
    conversationStore,
    authorize: (_path, principalId) => principalId === 'local:allowed',
    createConversationId: () => 'conv_created',
  });
  return {
    directory,
    workspaceA,
    workspaceB,
    conversationA,
    conversationB,
  };
}

function workspace(id: string, accountId: string, canonicalPath: string): WorkspaceRecord {
  return {
    id,
    accountId,
    displayName: id,
    canonicalPath,
    availability: 'available',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    createdByPrincipal: 'local:allowed',
    archived: false,
  };
}

function conversation(
  id: string,
  accountId: string,
  workspaceId: string,
): ConversationMetadata {
  return {
    id,
    plannerSessionId: id,
    accountId,
    title: `${accountId} private task`,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    archived: false,
    workspaceBinding: {
      workspaceId,
      boundAt: '2026-08-27T00:00:00.000Z',
      boundByPrincipal: 'local:allowed',
    },
  };
}
