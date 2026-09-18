import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Composer stop control', () => {
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

  it('routes the stop control through the WebSocket cancel frame', async () => {
    const ws = await readFile(new URL('api/ws.ts', root), 'utf8');
    expect(ws).toContain("type: 'cancel'");

    const app = await readFile(new URL('App.tsx', root), 'utf8');
    expect(app).toContain('sendCancel(');
    expect(app).toContain('onCancelTurn');
  });
});
