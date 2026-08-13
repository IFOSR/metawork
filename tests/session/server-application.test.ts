import { describe, expect, it, vi } from 'vitest';
import {
  ServerApplication,
  type ServerApplicationDeps,
  type ServerSurface,
} from '../../src/session/server-application.js';

function makeDeps(surface: ServerSurface, overrides: {
  surfaceFails?: boolean;
} = {}): { deps: ServerApplicationDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ServerApplicationDeps = {
    surface,
    startShared: vi.fn(async () => {
      calls.push('startShared');
      return { stop: vi.fn(async () => { calls.push('stopShared'); }) };
    }),
    startSurface: vi.fn(async (selected, shared) => {
      calls.push(`startSurface:${selected}`);
      if (overrides.surfaceFails) throw new Error('surface failed');
      return { stop: vi.fn(async () => { calls.push(`stopSurface:${selected}`); }) };
    }),
  };
  return { deps, calls };
}

describe('ServerApplication', () => {
  for (const surface of ['interactive', 'gateway', 'scripted', 'standby'] as ServerSurface[]) {
    it(`starts shared then the ${surface} surface`, async () => {
      const { deps, calls } = makeDeps(surface);
      const app = new ServerApplication(deps);
      await app.start();

      expect(calls).toEqual(['startShared', `startSurface:${surface}`]);
    });

    it(`stops the ${surface} surface before shared resources`, async () => {
      const { deps, calls } = makeDeps(surface);
      const app = new ServerApplication(deps);
      await app.start();
      await app.stop();

      expect(calls).toEqual([
        'startShared',
        `startSurface:${surface}`,
        `stopSurface:${surface}`,
        'stopShared',
      ]);
    });
  }

  it('stops shared resources when the surface fails to start', async () => {
    const { deps, calls } = makeDeps('gateway', { surfaceFails: true });
    const app = new ServerApplication(deps);

    await expect(app.start()).rejects.toThrow('surface failed');
    expect(calls).toEqual(['startShared', 'startSurface:gateway', 'stopShared']);
  });

  it('is idempotent for start and stop', async () => {
    const { deps, calls } = makeDeps('standby');
    const app = new ServerApplication(deps);
    await app.start();
    await app.start();
    await app.stop();
    await app.stop();

    expect(calls).toEqual(['startShared', 'startSurface:standby', 'stopSurface:standby', 'stopShared']);
  });
});
