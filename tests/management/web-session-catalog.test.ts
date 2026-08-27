import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSessionCatalog } from '../../src/management/web-session-catalog.js';
import {
  MAX_WEB_SESSION_EVENTS_PER_TURN,
  MAX_WEB_SESSION_TURNS,
  type ConversationTurn,
} from '../../src/management/web-session-types.js';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { FileWorkspaceCatalogStore } from '../../src/storage/file-workspace-catalog-store.js';
import { FileConversationPresentationStore } from '../../src/storage/file-conversation-presentation-store.js';
import { WorkspaceDirectoryService } from '../../src/workspace/workspace-directory-service.js';

const temporaryRoots: string[] = [];
const PRINCIPAL = 'web:client-a';

interface Fixture {
  readonly catalog: WebSessionCatalog;
  readonly conversationStore: FileConversationStore;
  readonly presentationStore: FileConversationPresentationStore;
  readonly workspaceId: string;
}

async function makeCatalog(
  timestamps: string[] = ['2026-08-17T08:00:00.000Z'],
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-web-session-catalog-'));
  temporaryRoots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const conversationStore = new FileConversationStore(join(root, 'conversations'));
  const workspaceStore = new FileWorkspaceCatalogStore(join(root, 'workspace-catalog'));
  const presentationStore = new FileConversationPresentationStore(join(root, 'presentation'));
  await Promise.all([
    conversationStore.initialize(),
    workspaceStore.initialize(),
    presentationStore.initialize(),
  ]);
  let conversationId = 0;
  let time = 0;
  const now = () => timestamps[Math.min(time++, timestamps.length - 1)]!;
  const directory = new WorkspaceDirectoryService({
    accountId: 'local-default',
    workspaceCatalog: workspaceStore,
    conversationStore,
    authorize: () => true,
    createWorkspaceId: () => 'workspace_repo',
    createConversationId: () => `conv_${++conversationId}`,
    now,
  });
  const selected = await directory.selectByPath(repo, PRINCIPAL);
  const catalog = new WebSessionCatalog({
    directory,
    conversationStore,
    presentationStore,
    now,
  });
  await catalog.initialize();
  return { catalog, conversationStore, presentationStore, workspaceId: selected.workspace.id };
}

function makeTurn(
  conversationId: string,
  index: number,
  userInput = `request ${index}`,
  traceEventCount = 1,
): ConversationTurn {
  return {
    id: `turn_${index}`,
    sessionId: conversationId,
    userInput,
    status: 'completed',
    finalAnswer: `answer ${index}`,
    taskId: `task_${index}`,
    startedAt: '2026-08-17T08:00:00.000Z',
    completedAt: '2026-08-17T08:00:05.000Z',
    traceEvents: Array.from({ length: traceEventCount }, (_, eventIndex) => ({
      id: `event_${index}_${eventIndex}`,
      sequence: eventIndex + 1,
      occurredAt: '2026-08-17T08:00:01.000Z',
      phase: 'planning' as const,
      actor: 'planner' as const,
      kind: 'planner_progress',
      status: 'completed' as const,
      title: 'Planner progress',
      summary: `safe summary ${eventIndex}`,
      details: {},
    })),
    executionTimeline: null,
    artifactRefs: [],
    artifacts: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('WebSessionCatalog', () => {
  it('uses WorkspaceDirectory metadata and keeps active selection out of persistence', async () => {
    const fixture = await makeCatalog([
      '2026-08-27T08:00:00.000Z',
      '2026-08-27T08:01:00.000Z',
      '2026-08-27T08:02:00.000Z',
    ]);
    const created = await fixture.catalog.create({
      workspaceId: fixture.workspaceId,
      principalId: PRINCIPAL,
    });
    await fixture.catalog.appendTurn(
      created.session.id,
      makeTurn(created.session.id, 1, '分析 Workspace Conversation 目录'),
    );

    expect(await fixture.catalog.list({
      workspaceId: fixture.workspaceId,
      principalId: PRINCIPAL,
      activeConversationId: created.session.id,
    })).toMatchObject([{
      id: created.session.id,
      title: '分析 Workspace Conversation 目录',
      active: true,
    }]);
    expect((await fixture.conversationStore.readConversation(created.session.id))?.conversation)
      .not.toHaveProperty('active');
    expect(await fixture.presentationStore.read(created.session.id)).toMatchObject({
      turns: [{ userInput: '分析 Workspace Conversation 目录' }],
    });
  });

  it('uses the first ordinary user query as unified Conversation title', async () => {
    const fixture = await makeCatalog(Array.from(
      { length: 6 },
      (_, index) => new Date(Date.UTC(2026, 7, 17, 8, 0, index)).toISOString(),
    ));
    const created = await fixture.catalog.create({
      workspaceId: fixture.workspaceId,
      principalId: PRINCIPAL,
    });
    await fixture.catalog.appendTurn(created.session.id, makeTurn(
      created.session.id,
      1,
      '/workspace /repo-a',
    ));
    await fixture.catalog.appendTurn(created.session.id, makeTurn(
      created.session.id,
      2,
      '分析这个项目的模块边界',
    ));
    await fixture.catalog.appendTurn(created.session.id, makeTurn(
      created.session.id,
      3,
      '继续检查测试覆盖率',
    ));

    expect((await fixture.catalog.read(created.session.id))?.session.title)
      .toBe('分析这个项目的模块边界');
    expect((await fixture.conversationStore.readConversation(created.session.id))
      ?.conversation.title).toBe('分析这个项目的模块边界');
  });

  it('searches only Server-owned titles in the selected Workspace', async () => {
    const fixture = await makeCatalog(Array.from(
      { length: 8 },
      (_, index) => new Date(Date.UTC(2026, 7, 17, 8, 0, index)).toISOString(),
    ));
    const first = await fixture.catalog.create({ workspaceId: fixture.workspaceId, principalId: PRINCIPAL });
    const second = await fixture.catalog.create({ workspaceId: fixture.workspaceId, principalId: PRINCIPAL });
    await fixture.catalog.appendTurn(first.session.id, makeTurn(first.session.id, 1, 'Market briefing'));
    await fixture.catalog.appendTurn(second.session.id, makeTurn(second.session.id, 2, 'Research notes'));

    expect((await fixture.catalog.search({
      workspaceId: fixture.workspaceId,
      principalId: PRINCIPAL,
      query: 'MARKET',
    })).map(session => session.id)).toEqual([first.session.id]);
  });

  it('bounds retained rich turns and each turn trace', async () => {
    const fixture = await makeCatalog(Array.from(
      { length: MAX_WEB_SESSION_TURNS + 6 },
      (_, index) => new Date(Date.UTC(2026, 7, 17, 8, 0, index)).toISOString(),
    ));
    const created = await fixture.catalog.create({ workspaceId: fixture.workspaceId, principalId: PRINCIPAL });
    for (let index = 1; index <= MAX_WEB_SESSION_TURNS + 2; index += 1) {
      await fixture.catalog.appendTurn(created.session.id, makeTurn(
        created.session.id,
        index,
        index === 1 ? 'Explain the Planner execution flow' : `request ${index}`,
        index === 3 ? MAX_WEB_SESSION_EVENTS_PER_TURN + 2 : 1,
      ));
    }

    const updated = await fixture.catalog.read(created.session.id);
    expect(updated?.turns).toHaveLength(MAX_WEB_SESSION_TURNS);
    expect(updated?.turns[0]?.id).toBe('turn_3');
    expect(updated?.turns[0]?.traceEvents).toHaveLength(MAX_WEB_SESSION_EVENTS_PER_TURN);
  });

  it('archives unified Conversation metadata without deleting rich presentation', async () => {
    const fixture = await makeCatalog();
    const created = await fixture.catalog.create({ workspaceId: fixture.workspaceId, principalId: PRINCIPAL });
    await fixture.catalog.appendTurn(created.session.id, makeTurn(created.session.id, 1));

    await expect(fixture.catalog.archive(
      created.session.id,
      fixture.workspaceId,
      PRINCIPAL,
    )).resolves.toBe(true);

    expect((await fixture.conversationStore.readConversation(created.session.id))
      ?.conversation.archived).toBe(true);
    expect(await fixture.presentationStore.read(created.session.id)).not.toBeNull();
  });

  it('retains sanitized executor progress in presentation only', async () => {
    const fixture = await makeCatalog();
    const created = await fixture.catalog.create({ workspaceId: fixture.workspaceId, principalId: PRINCIPAL });
    const turn = makeTurn(created.session.id, 1);
    turn.executionTimeline = {
      taskId: 'task_1',
      title: 'Research',
      status: 'running',
      stages: [{
        phase: 'execution',
        status: 'running',
        subtasks: [{
          id: 'sub_1',
          title: 'Analyze data',
          status: 'running',
          executor: 'pi-agent',
          attempts: [{
            attemptId: 'attempt_1',
            result: 'running',
            status: 'running',
            startedAt: '2026-08-17T08:00:00.000Z',
            updatedAt: '2026-08-17T08:00:01.000Z',
            progress: { text: 'token=secret-value analyzing data' },
            progressHistory: [{
              kind: 'log',
              text: 'token=secret-value analyzing data',
              occurredAt: '2026-08-17T08:00:01.000Z',
            }],
          }],
        }],
      }],
    };

    await fixture.catalog.appendTurn(created.session.id, turn);
    const attempt = (await fixture.presentationStore.read(created.session.id))
      ?.turns[0]?.executionTimeline?.stages[0]?.subtasks?.[0]?.attempts[0];
    expect(attempt).toMatchObject({ progressHistory: [{ text: 'token=[REDACTED] analyzing data' }] });
  });
});
