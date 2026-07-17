import { describe, expect, it } from 'vitest';
import { CodexCliAdapter } from '../../src/executor/codex-cli.js';
import { buildCodexNonInteractiveArgs } from '../../src/executor/codex-args.js';

describe('CodexCliAdapter', () => {
  it('uses non-interactive Codex arguments', () => {
    const args = buildCodexNonInteractiveArgs('prompt', { ephemeral: false });
    expect(args).toContain('exec');
    expect(args).toContain('prompt');
  });

  it('renders only the SubtaskExecutionContext contract', () => {
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
    const prompt = (adapter as any).buildContextPrompt({ context: {
      taskBackground: { id: 'task', title: 'Task', goal: 'background', instruction: 'background_only' },
      currentSubtask: { id: 'a', title: 'A', goal: 'do A', expectedOutput: 'summary', acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }] },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'e', taskId: 'task', subtaskId: 'a', attemptId: 'attempt', workUnitId: 'wu' },
      completionContract: { marker: '<!-- metaclaw:completion:v1 -->', schemaVersion: 1 },
      evidenceTools: { availability: 'unavailable', reason: 'test' },
    } });
    expect(prompt).toContain('Operative goal: do A');
    expect(prompt).toContain('/repo/out');
  });

  it('binds the attempt-scoped evidence MCP without rendering its token into the prompt', () => {
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
    const input = { context: {
      taskBackground: { id: 'task', title: 'Task', goal: 'background', instruction: 'background_only' as const },
      currentSubtask: { id: 'a', title: 'A', goal: 'do A', expectedOutput: 'summary' as const, acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }] },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'e', taskId: 'task', subtaskId: 'a', attemptId: 'attempt', workUnitId: 'wu' },
      completionContract: { marker: '<!-- metaclaw:completion:v1 -->' as const, schemaVersion: 1 as const },
      evidenceTools: {
        availability: 'available' as const,
        reason: 'test',
        binding: { mcpUrl: 'http://127.0.0.1:1234/mcp', jsonUrl: 'http://127.0.0.1:1234/evidence', bearerToken: 'secret-token' },
      },
    } };
    const execution = (adapter as any).prepareExecution('prompt', input);
    const joined = execution.args.join(' ');
    expect(joined).toContain('mcp_servers.metaclaw_evidence.url');
    expect(joined).toContain('METACLAW_EVIDENCE_TOKEN');
    expect(joined).not.toContain('secret-token');
    expect((adapter as any).buildSpawnEnv(input).METACLAW_EVIDENCE_TOKEN).toBe('secret-token');
    execution.cleanup();
  });
});
