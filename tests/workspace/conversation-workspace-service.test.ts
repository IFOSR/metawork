import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { CONVERSATION_FORMAT_VERSION, type ConversationRecord } from '../../src/session/conversation-store.js';
import {
  ConversationWorkspaceService,
  type WorkspaceAuthorization,
} from '../../src/workspace/conversation-workspace-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conversation-workspace-'));
  roots.push(root);
  const workspace = join(root, 'repo');
  await mkdir(workspace);
  const store = new FileConversationStore(join(root, 'conversations'));
  await store.initialize();
  const record: ConversationRecord = {
    version: CONVERSATION_FORMAT_VERSION,
    conversation: {
      id: 'conv_1',
      plannerSessionId: 'planner_1',
      accountId: 'local-default',
      title: 'Workspace test',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      archived: false,
      workspace: null,
    },
    turns: [],
  };
  await store.writeConversation(record);
  await store.writeCatalog({ version: CONVERSATION_FORMAT_VERSION, conversations: [record.conversation] });
  return { root, workspace, store };
}

function service(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<WorkspaceAuthorization> = {},
) {
  return new ConversationWorkspaceService({
    store: fixtureValue.store,
    conversationId: 'conv_1',
    principalId: 'local:installation',
    authorize: async () => true,
    isBusy: () => false,
    ...overrides,
  });
}

describe('ConversationWorkspaceService', () => {
  it('sets only an absolute accessible directory after realpath canonicalization', async () => {
    const value = await fixture();
    const result = await service(value).execute(`/workspace ${value.workspace}`);
    const canonicalPath = await realpath(value.workspace);

    expect(result).toEqual({
      status: 'changed',
      workspace: {
        path: canonicalPath,
        selectedAt: expect.any(String),
        selectedByPrincipal: 'local:installation',
      },
    });
    expect((await value.store.readConversation('conv_1'))?.conversation.workspace?.path)
      .toBe(canonicalPath);
  });

  it('rejects relative, missing, file, inaccessible, or unauthorized paths', async () => {
    const value = await fixture();
    const filePath = join(value.root, 'not-a-directory');
    await writeFile(filePath, 'file');
    await expect(service(value).execute('/workspace relative')).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_path_invalid',
    });
    await expect(service(value).execute('/workspace /does/not/exist')).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_path_invalid',
    });
    await expect(service(value).execute(`/workspace ${filePath}`)).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_path_invalid',
    });
    await expect(service(value, { authorize: async () => false }).execute(`/workspace ${value.workspace}`))
      .resolves.toMatchObject({ status: 'rejected', code: 'workspace_unauthorized' });
    await expect(service(value, { isBusy: () => true }).execute(`/workspace ${value.workspace}`))
      .resolves.toMatchObject({ status: 'rejected', code: 'workspace_busy' });
  });

  it('rejects commands other than the canonical Workspace command', async () => {
    const value = await fixture();
    await expect(service(value).execute('/workspace')).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_command_invalid',
    });
    await expect(service(value).execute('/workspace /tmp/a /tmp/b')).resolves.toMatchObject({
      status: 'rejected',
      code: 'workspace_command_invalid',
    });
  });
});
