import { describe, expect, it } from 'vitest';
import { SessionStreamAdapter } from '../../src/session/session-transport-adapter.js';

describe('SessionStreamAdapter', () => {
  it('reports submit lifecycle with the stable output cursor', async () => {
    const events: string[] = [];
    let listener: ((snapshot: { output: string[] }) => void) | null = null;
    const session = {
      subscribe(next: (snapshot: { output: string[] }) => void) {
        listener = next;
        next({ output: ['existing'] });
        return () => {};
      },
      async submit(text: string) {
        events.push(`session:${text}`);
        listener?.({ output: ['existing', 'answer'] });
        return { exitRequested: false };
      },
    };
    const adapter = new SessionStreamAdapter(session as never, {
      onOutput: (lines, from) => events.push(`output:${from}:${lines.join('|')}`),
      onSubmitStarted: (text, outputFrom) => events.push(`start:${text}:${outputFrom}`),
      onSubmitCompleted: text => events.push(`complete:${text}`),
    });
    adapter.attach();

    await adapter.submit('question');

    expect(events).toEqual([
      'output:0:existing',
      'start:question:1',
      'session:question',
      'output:1:answer',
      'complete:question',
    ]);
  });

  it('reports submit failure before rethrowing it', async () => {
    const events: string[] = [];
    const failure = new Error('planner failed');
    const session = {
      subscribe() {
        return () => {};
      },
      async submit() {
        throw failure;
      },
    };
    const adapter = new SessionStreamAdapter(session as never, {
      onOutput: () => {},
      onSubmitFailed: (_text, error) => events.push((error as Error).message),
    });

    await expect(adapter.submit('question')).rejects.toBe(failure);
    expect(events).toEqual(['planner failed']);
  });
});
