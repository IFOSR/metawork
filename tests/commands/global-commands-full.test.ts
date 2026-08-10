import { describe, expect, it } from 'vitest';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';

describe('global commands', () => {
  it('includes /task history and /config in help output', async () => {
    const result = await createDefaultCommandCatalog().execute('/help', {} as any);

    expect(result.content).toContain('/task history');
    expect(result.content).toContain('/config');
  });
});
