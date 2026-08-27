import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { WorkspaceConversationMigrator } from '../../src/workspace/workspace-conversation-migrator.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Workspace Directory recovery', () => {
  it('finishes a prepared v2-to-v3 migration after catalogs switched but records did not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-directory-recovery-'));
    roots.push(root);
    const conversationsRoot = join(root, 'conversations');
    const workspaceCatalogRoot = join(root, 'workspace-catalog');
    const stageRoot = join(workspaceCatalogRoot, '.migration-interrupted');
    await Promise.all([
      mkdir(join(conversationsRoot, 'records'), { recursive: true }),
      mkdir(join(stageRoot, 'conversations', 'records'), { recursive: true }),
    ]);
    const workspace = workspaceRecord(join(root, 'missing-repo'));
    const metadata = conversationMetadata();
    await writeJson(join(workspaceCatalogRoot, 'catalog.json'), {
      version: 1,
      workspaces: [workspace],
    });
    await writeJson(join(conversationsRoot, 'catalog.json'), {
      version: 3,
      conversations: [metadata],
    });
    await writeJson(join(conversationsRoot, 'records', 'conv_recover.json'), {
      version: 2,
      conversation: {
        ...metadata,
        workspaceBinding: undefined,
        workspace: {
          path: workspace.canonicalPath,
          selectedAt: metadata.workspaceBinding.boundAt,
          selectedByPrincipal: metadata.workspaceBinding.boundByPrincipal,
        },
      },
      turns: [],
    });
    await writeJson(join(stageRoot, 'conversations', 'records', 'conv_recover.json'), {
      version: 3,
      conversation: metadata,
      turns: [],
    });
    await writeJson(join(workspaceCatalogRoot, 'migration.json'), {
      version: 1,
      state: 'prepared',
      stageRoot,
    });

    await new WorkspaceConversationMigrator({
      accountId: 'local-default',
      conversationsRoot,
      workspaceCatalogRoot,
    }).migrate();

    const conversationStore = new FileConversationStore(conversationsRoot);
    await expect(conversationStore.readConversation('conv_recover'))
      .resolves.toMatchObject({
        version: 3,
        conversation: {
          workspaceBinding: { workspaceId: 'workspace_recover' },
        },
      });
    await expect(access(join(workspaceCatalogRoot, 'migration.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores unavailable Workspace history but rejects new execution Conversations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-unavailable-restart-'));
    roots.push(root);
    const workspaceCatalog = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
    const conversationStore = new FileConversationStore(join(root, 'conversations'));
    await Promise.all([workspaceCatalog.initialize(), conversationStore.initialize()]);
    const workspace = workspaceRecord(join(root, 'missing-repo'));
    const metadata = conversationMetadata();
    await workspaceCatalog.writeCatalog({ version: 1, workspaces: [workspace] });
    await conversationStore.writeCatalog({ version: 3, conversations: [metadata] });
    await conversationStore.writeConversation({
      version: 3,
      conversation: metadata,
      turns: [{
        id: 'turn_1',
        conversationId: metadata.id,
        userInput: 'show history',
        finalAnswer: 'preserved answer',
        status: 'completed',
      }],
    });

    const restarted = new WorkspaceDirectoryService({
      accountId: 'local-default',
      workspaceCatalog: new FileWorkspaceCatalogStore(join(root, 'workspace-catalog')),
      conversationStore: new FileConversationStore(join(root, 'conversations')),
      authorize: () => true,
    });

    await expect(restarted.listWorkspaces('local:local-installation'))
      .resolves.toEqual([workspace]);
    await expect(restarted.listConversations(
      workspace.id,
      'local:local-installation',
    )).resolves.toMatchObject({
      items: [{ conversationId: metadata.id, workspaceId: workspace.id }],
    });
    await expect(restarted.createConversation(
      workspace.id,
      'local:local-installation',
    )).rejects.toThrow('workspace_unavailable');
  });
});

function workspaceRecord(canonicalPath: string) {
  return {
    id: 'workspace_recover',
    accountId: 'local-default',
    displayName: 'Recovered Workspace',
    canonicalPath,
    availability: 'unavailable' as const,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    createdByPrincipal: 'local:local-installation',
    archived: false,
  };
}

function conversationMetadata() {
  return {
    id: 'conv_recover',
    plannerSessionId: 'conv_recover',
    accountId: 'local-default',
    title: 'Recovered task',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    archived: false,
    workspaceBinding: {
      workspaceId: 'workspace_recover',
      boundAt: '2026-08-27T00:00:00.000Z',
      boundByPrincipal: 'local:local-installation',
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await readFile(path, 'utf8');
}
