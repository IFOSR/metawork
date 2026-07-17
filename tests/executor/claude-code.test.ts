import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/executor/claude-code.js';

describe('ClaudeCodeAdapter', () => {
  it('uses print mode and explicit permission bypass', () => {
    const adapter = new ClaudeCodeAdapter({ command: 'claude', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');
    expect(args).toContain('--print');
    expect(args).toContain('--dangerously-skip-permissions');
  });
});
