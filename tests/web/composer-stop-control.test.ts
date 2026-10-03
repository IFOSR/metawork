import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Composer } from '../../web/src/components/Composer';
import { mergeFinalAnswer, mergeTraceDelta } from '../../web/src/conversation-live-turn';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';

const root = new URL('../../web/src/', import.meta.url);
const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Composer stop control', () => {
  it('restores Send and removes Stop on a cancellation trace without a page reload', () => {
    const turn: ConversationTurnProjection = {
      id: 'turn_stop',
      sessionId: 'conv_stop',
      userInput: 'Run a task',
      taskId: 'task_stop',
      status: 'running',
      startedAt: '2026-09-21T00:00:00.000Z',
      completedAt: null,
      finalAnswer: null,
      traceEvents: [],
      executionTimeline: null,
      artifactRefs: [],
      artifacts: [],
    };
    const render = (current: ConversationTurnProjection | null) => renderToStaticMarkup(
      createElement(Composer, {
        draft: 'next request',
        disabled: false,
        running: current?.status === 'running',
        attachments: [],
        onDraftChange: () => undefined,
        onSend: () => undefined,
        onCancel: () => undefined,
        onFilesSelected: () => undefined,
        onRemoveAttachment: () => undefined,
      }),
    );
    expect(render(turn)).toContain('执行中');
    expect(render(turn)).toContain('stop-button');

    const cancelled = mergeTraceDelta(turn, turn.id, [], 'cancelled', '2026-09-21T00:01:00.000Z');
    const lateAnswer = mergeFinalAnswer(cancelled, turn.id, ['stopped'], '2026-09-21T00:02:00.000Z', true);
    const html = render(lateAnswer);
    expect(html).toContain('<button type="submit">发送</button>');
    expect(html).not.toContain('stop-button');
    expect(html).not.toContain('执行中');
  });

  it('cancels the current turn instead of sending a Task command', async () => {
    const composer = await readFile(new URL('components/Composer.tsx', root), 'utf8');

    // Regression: the stop button used to send `/task clear all`, which cancels
    // Tasks only. While the Planner was still planning there was no Task, so the
    // run continued and its result still appeared.
    expect(composer).not.toContain("'/task clear all'");
    expect(composer).toContain('onCancel()');
    expect(composer).toContain('onCancel: () => void;');
    expect(composer).toContain('停止当前轮');
  });

  it('routes the stop control through an explicitly targeted Gateway command', async () => {
    const ws = await readFile(new URL('api/ws.ts', root), 'utf8');
    expect(ws).toContain("type: 'command'");
    expect(ws).toContain("selection: { mode: 'attach', conversationId }");

    const app = await Promise.all(['App.tsx', 'observation/use-workspace-controller.ts'].map(path => readFile(new URL(path, root), 'utf8'))).then(parts => parts.join('\n'));
    expect(app).toContain("sendCommand(target, { kind: 'cancel_turn', turnId })");
    expect(app).toContain('onCancelTurn');
  });
});
