import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-directory-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const workspaceCatalog = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
  const conversationStore = new FileConversationStore(join(root, 'conversations'));
  await Promise.all([workspaceCatalog.initialize(), conversationStore.initialize()]);
  let workspaceSequence = 0;
  let conversationSequence = 0;
  const service = new WorkspaceDirectoryService({
    accountId: 'local-default',
    workspaceCatalog,
    conversationStore,
    authorize: () => true,
    createWorkspaceId: () => `workspace_${++workspaceSequence}`,
    createConversationId: () => `conv_${++conversationSequence}`,
    now: () => '2026-08-27T00:00:00.000Z',
  });
  return { repo, workspaceCatalog, conversationStore, service };
}

describe('WorkspaceDirectoryService', () => {
  it('resolves the same realpath to one Workspace', async () => {
    const value = await fixture();
    const first = await value.service.selectByPath(value.repo, 'local:local-installation');
    const second = await value.service.selectByPath(await realpath(value.repo), 'local:local-installation');
    expect(first.workspace.id).toBe(second.workspace.id);
    expect(second.created).toBe(false);
  });

  it('creates Conversations inside the selected Workspace and pages at 100', async () => {
    const value = await fixture();
    const selected = await value.service.selectByPath(value.repo, 'local:local-installation');
    for (let index = 0; index < 105; index += 1) {
      await value.service.createConversation(selected.workspace.id, 'local:local-installation');
    }
    const first = await value.service.listConversations(
      selected.workspace.id,
      'local:local-installation',
      { limit: 500 },
    );
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items.every(item => item.workspaceId === selected.workspace.id)).toBe(true);
  });

  it('fails closed for unauthorized paths', async () => {
    const value = await fixture();
    const service = new WorkspaceDirectoryService({
      accountId: 'local-default',
      workspaceCatalog: value.workspaceCatalog,
      conversationStore: value.conversationStore,
      authorize: () => false,
    });
    await expect(service.selectByPath(value.repo, 'local:local-installation'))
      .rejects.toThrow('workspace_unauthorized');
  });

  it('authorizes Conversation membership through the Workspace directory boundary', async () => {
    const value = await fixture();
    const selected = await value.service.selectByPath(
      value.repo,
      'feishu:tenant:user',
    );
    const conversation = await value.service.createConversation(
      selected.workspace.id,
      'feishu:tenant:user',
    );

    await expect(value.service.resolveConversationWorkspace(
      conversation.id,
      'feishu:tenant:user',
    )).resolves.toBe(selected.workspace.id);
    await expect(value.service.isConversationInWorkspace(
      selected.workspace.id,
      conversation.id,
      'feishu:tenant:user',
    )).resolves.toBe(true);
    await expect(value.service.isConversationInWorkspace(
      'workspace_other',
      conversation.id,
      'feishu:tenant:user',
    )).resolves.toBe(false);
    await expect(value.service.resolveConversationWorkspace(
      'conv_missing',
      'feishu:tenant:user',
    )).resolves.toBeNull();
  });
});
