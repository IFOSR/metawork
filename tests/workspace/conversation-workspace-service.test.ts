import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { CONVERSATION_FORMAT_VERSION, type ConversationRecord } from '../../src/session/conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import {
  ConversationWorkspaceService,
  isAuthenticatedWorkspacePrincipalId,
} from '../../src/workspace/conversation-workspace-service.js';
import { WORKSPACE_CATALOG_VERSION } from '../../src/workspace/workspace-types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(withTurn = false) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-workspace-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const store = new FileConversationStore(join(root, 'conversations'));
  const workspaceCatalog = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
  await Promise.all([store.initialize(), workspaceCatalog.initialize()]);
  await workspaceCatalog.writeCatalog({
    version: WORKSPACE_CATALOG_VERSION,
    workspaces: [{
      id: 'workspace_repo',
      accountId: 'local-default',
      displayName: 'repo',
      canonicalPath: repo,
      availability: 'available',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      createdByPrincipal: 'local:local-installation',
      archived: false,
    }],
  });
  const record: ConversationRecord = {
    version: CONVERSATION_FORMAT_VERSION,
    conversation: {
      id: 'conv_1',
      plannerSessionId: 'planner_1',
      accountId: 'local-default',
      title: 'Workspace test',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      archived: false,
      workspaceBinding: null,
    },
    turns: withTurn ? [{
      id: 'turn_1',
      conversationId: 'conv_1',
      userInput: 'ordinary query',
      finalAnswer: 'done',
      status: 'completed',
    }] : [],
  };
  await store.writeConversation(record);
  await store.writeCatalog({ version: CONVERSATION_FORMAT_VERSION, conversations: [record.conversation] });
  return {
    store,
    workspaceCatalog,
    service: new ConversationWorkspaceService({
      store,
      workspaceCatalog,
      conversationId: 'conv_1',
      isBusy: () => false,
    }),
  };
}

describe('ConversationWorkspaceService', () => {
  it('binds an empty Conversation to a Workspace id', async () => {
    const value = await fixture();
    const result = await value.service.bindEmptyConversation(
      'workspace_repo',
      'local:local-installation',
    );
    expect(result).toMatchObject({
      status: 'changed',
      workspace: { workspaceId: 'workspace_repo' },
    });
    expect((await value.store.readConversation('conv_1'))?.conversation.workspaceBinding)
      .toMatchObject({ workspaceId: 'workspace_repo' });
  });

  it('locks binding after the first ordinary query', async () => {
    const value = await fixture(true);
    await expect(value.service.bindEmptyConversation(
      'workspace_repo',
      'local:local-installation',
    )).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_binding_locked',
    });
  });

  it('accepts only authenticated Principal identifiers at the production seam', () => {
    expect(isAuthenticatedWorkspacePrincipalId('local:local-installation')).toBe(true);
    expect(isAuthenticatedWorkspacePrincipalId('web:local-web-user')).toBe(true);
    expect(isAuthenticatedWorkspacePrincipalId('feishu:tenant:user')).toBe(true);
    expect(isAuthenticatedWorkspacePrincipalId('local:forged')).toBe(false);
  });
});
