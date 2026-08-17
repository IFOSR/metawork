import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/', import.meta.url);

describe('Web interaction trace panel', () => {
  it('renders detailed streamed phases, actors, routing details, and responsive state', async () => {
    const [panel, app, chat, styles] = await Promise.all([
      readFile(new URL('components/InteractionTracePanel.tsx', root), 'utf8'),
      readFile(new URL('App.tsx', root), 'utf8'),
      readFile(new URL('components/ChatPane.tsx', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    expect(panel).toContain('trace.events.map');
    expect(panel).toContain('PHASE_LABEL');
    expect(panel).toContain('ACTOR_LABEL');
    expect(panel).toContain('<details');
    expect(panel).toContain('authorizedBinding');
    expect(panel).toContain('data-streaming');
    expect(app).toContain('onTraceSnapshot');
    expect(app).toContain('onTraceDelta');
    expect(app).toContain('<InteractionTracePanel');
    expect(chat).not.toContain('ExecutionTrace');
    expect(styles).toContain('@media (max-width: 820px)');
    expect(styles).toContain('@keyframes trace-pulse');
  });
});
