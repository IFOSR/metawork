import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_PRESENTATION_VERSION,
  FileConversationPresentationStore,
} from '../../src/storage/file-conversation-presentation-store.js';
import type { ConversationTurn } from '../../src/management/web-session-types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function turn(conversationId: string): ConversationTurn {
  return {
    id: 'turn_1',
    sessionId: conversationId,
    userInput: 'Inspect the project',
    status: 'completed',
    finalAnswer: 'Completed',
    taskId: null,
    startedAt: '2026-08-27T08:00:00.000Z',
    completedAt: '2026-08-27T08:01:00.000Z',
    traceEvents: [],
    executionTimeline: null,
    artifactRefs: [],
    artifacts: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-conversation-presentation-'));
  roots.push(root);
  const store = new FileConversationPresentationStore(root);
  await store.initialize();
  return { root, store };
}

describe('FileConversationPresentationStore', () => {
  it('persists only Conversation-keyed rich presentation without a metadata catalog', async () => {
    const { root, store } = await fixture();
    await store.write({
      version: CONVERSATION_PRESENTATION_VERSION,
      conversationId: 'conv_alpha',
      turns: [turn('conv_alpha')],
    });

    expect(await store.read('conv_alpha')).toMatchObject({
      conversationId: 'conv_alpha',
      turns: [{ userInput: 'Inspect the project' }],
    });
    expect(await readdir(root)).toEqual(['quarantine', 'records']);
    expect(await readFile(join(root, 'records', 'conv_alpha.json'), 'utf8'))
      .not.toMatch(/"title"|"active"|"archived"|"workspace"/u);
  });

  it('quarantines malformed records and rejects traversal ids', async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, 'records', 'conv_bad.json'), '{broken', 'utf8');

    await expect(store.read('../escape')).rejects.toThrow('Invalid Conversation ID');
    await expect(store.read('conv_bad')).resolves.toBeNull();
    expect(await readdir(join(root, 'quarantine'))).toEqual([
      expect.stringMatching(/^conv_bad\.\d+\.invalid\.json$/u),
    ]);
  });

  it('deletes only the presentation record without owning Conversation deletion', async () => {
    const { store } = await fixture();
    await store.write({
      version: CONVERSATION_PRESENTATION_VERSION,
      conversationId: 'conv_alpha',
      turns: [turn('conv_alpha')],
    });

    await expect(store.delete('conv_alpha')).resolves.toBe(true);
    await expect(store.read('conv_alpha')).resolves.toBeNull();
  });
});
