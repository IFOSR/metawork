import { describe, expect, it } from 'vitest';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';

describe('global commands', () => {
  it('keeps daily help short and exposes advanced commands separately', async () => {
    const catalog = createDefaultCommandCatalog();
    const result = await catalog.execute('/help', {} as any);
    const advanced = await catalog.execute('/help advanced', {} as any);

    expect(result.content).not.toContain('/task history');
    expect(result.content).not.toContain('/config');
    expect(advanced.content).toContain('/task history');
    expect(advanced.content).toContain('/config');
  });
});
