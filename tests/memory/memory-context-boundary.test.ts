import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 2 Executor context boundary', () => {
  it('removes Task-level memory/history construction from Session execution', () => {
    const source = readFileSync('src/session/session-execution-coordinator.ts', 'utf8');
    expect(source).not.toContain('prepareExecutionContext');
    expect(source).not.toContain('memoryContextService');
    expect(source).not.toContain('conversationHistory');
  });

  it('defines SubtaskExecutionContext as the Adapter input contract', () => {
    const adapter = readFileSync('src/executor/adapter.ts', 'utf8');
    expect(adapter).toContain('context: SubtaskExecutionContext');
    expect(adapter).not.toContain('executionContextBundle');
    expect(adapter).not.toContain('userPrompt:');
  });
});
