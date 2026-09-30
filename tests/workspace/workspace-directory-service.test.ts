import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('uses an indexed page without reading the catalog or activity sources', async () => {
    const value = await fixture();
    const selection = await value.service.selectByPath(value.repo, 'local');
    const page = vi.fn(() => ({ items: [], nextCursor: null, projectionVersion: 1 }));
    const readCatalog = vi.spyOn(value.conversationStore, 'readCatalog')
      .mockRejectedValue(new Error('unbounded catalog scan'));
    const getConversationActivity = vi.fn(() => { throw new Error('activity scan'); });
    const service = new WorkspaceDirectoryService({
      accountId: 'local-default', workspaceCatalog: value.workspaceCatalog,
      conversationStore: value.conversationStore, authorize: () => true,
      projection: { page } as never, getConversationActivity,
    });
    await expect(service.listConversations(selection.workspace.id, 'local', { limit: 10 }))
      .resolves.toEqual({ items: [], nextCursor: null, projectionVersion: 1 });
    expect(page).toHaveBeenCalledWith(selection.workspace.id, { limit: 10 });
    expect(readCatalog).not.toHaveBeenCalled();
    expect(getConversationActivity).not.toHaveBeenCalled();
  });
  it('retains every Conversation when clients create concurrently', async () => {
    const value = await fixture();
    const selected = await value.service.selectByPath(value.repo, 'local:local-installation');
    const created = await Promise.all(Array.from({ length: 12 }, () => (
      value.service.createConversation(selected.workspace.id, 'local:local-installation')
    )));
    const catalog = await value.conversationStore.readCatalog();
    expect(catalog.conversations.map(item => item.id).sort())
      .toEqual(created.map(item => item.id).sort());
  });

  it('filters unrelated and archived metadata before one batched activity projection', async () => {
    const value = await fixture();
    const selected = await value.service.selectByPath(value.repo, 'local:local-installation');
    const conversation = await value.service.createConversation(selected.workspace.id, 'local:local-installation');
    await value.conversationStore.writeCatalog({
      version: 3,
      conversations: [
        conversation,
        { ...conversation, id: 'conv_archived', archived: true },
        { ...conversation, id: 'conv_unbound', workspaceBinding: null },
        { ...conversation, id: 'conv_other', workspaceBinding: {
          ...conversation.workspaceBinding!, workspaceId: 'workspace_other',
        } },
      ],
    });
    const getConversationActivity = vi.fn(() => {
      throw new Error('per-row account scan');
    });
    const getConversationActivities = vi.fn(() => new Map([
      [conversation.id, { state: 'blocked' as const, taskId: 'task_1', updatedAt: conversation.updatedAt }],
    ]));
    const service = new WorkspaceDirectoryService({
      accountId: 'local-default',
      workspaceCatalog: value.workspaceCatalog,
      conversationStore: value.conversationStore,
      authorize: () => true,
      getConversationActivity,
      getConversationActivities,
    });
    const page = await service.listConversations(selected.workspace.id, 'local:local-installation');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.activity.state).toBe('blocked');
    expect(getConversationActivities).toHaveBeenCalledTimes(1);
    expect(getConversationActivities).toHaveBeenCalledWith([{
      conversationId: conversation.id, updatedAt: conversation.updatedAt,
    }]);
    expect(getConversationActivity).not.toHaveBeenCalled();
  });

  it('sorts Conversations by the newest Task creation time, not activity state', async () => {
    const value = await fixture();
    const selected = await value.service.selectByPath(value.repo, 'local:local-installation');
    const older = await value.service.createConversation(selected.workspace.id, 'local:local-installation');
    const newer = await value.service.createConversation(selected.workspace.id, 'local:local-installation');
    const getConversationActivities = () => new Map([
      [older.id, {
        state: 'blocked' as const,
        taskId: 'task_old',
        updatedAt: '2026-09-30T01:00:00.000Z',
        latestTaskCreatedAt: '2026-09-29T23:00:00.000Z',
      }],
      [newer.id, {
        state: 'idle' as const,
        taskId: null,
        updatedAt: '2026-09-30T02:00:00.000Z',
        latestTaskCreatedAt: '2026-09-30T02:00:00.000Z',
      }],
    ]);
    const service = new WorkspaceDirectoryService({
      accountId: 'local-default',
      workspaceCatalog: value.workspaceCatalog,
      conversationStore: value.conversationStore,
      authorize: () => true,
      getConversationActivities,
    });

    const page = await service.listConversations(selected.workspace.id, 'local:local-installation');

    expect(page.items.map(item => item.conversationId)).toEqual([newer.id, older.id]);
  });

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
