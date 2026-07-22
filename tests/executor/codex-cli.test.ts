import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter } from '../../src/executor/codex-cli.js';
import { buildCodexNonInteractiveArgs, buildCodexResumeArgs } from '../../src/executor/codex-args.js';

describe('CodexCliAdapter', () => {
  it('uses non-interactive Codex arguments', () => {
    const args = buildCodexNonInteractiveArgs('prompt', { ephemeral: false });
    expect(args).toContain('exec');
    expect(args).toContain('prompt');
  });

  it('builds an explicit resume invocation and captures the persisted thread id', () => {
    const args = buildCodexResumeArgs('019f-thread', 'continue', { outputLastMessagePath: 'last.txt' });
    expect(args.slice(0, 6)).toEqual(['exec', 'resume', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"']);
    expect(args).toContain('never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('019f-thread');
    expect(args).toContain('--json');

    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
    const onContinuationToken = vi.fn();
    (adapter as any).observeOutputLine(JSON.stringify({ type: 'thread.started', thread_id: '019f-thread' }), {
      context: {}, recovery: { mode: 'fresh', continuationToken: null, onContinuationToken },
    });
    expect(onContinuationToken).toHaveBeenCalledWith('019f-thread');
  });

  it('renders only the SubtaskExecutionContext contract', () => {
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
    const prompt = (adapter as any).buildContextPrompt({ context: {
      taskBackground: { id: 'task', title: 'Task', goal: 'background', instruction: 'background_only' },
      currentSubtask: { id: 'a', title: 'A', goal: 'do A', expectedOutput: 'summary', acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }] },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'e', taskId: 'task', subtaskId: 'a', attemptId: 'attempt', workUnitId: 'wu' },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->', schemaVersion: 2 },
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
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->' as const, schemaVersion: 2 as const },
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

  it('uses codex exec resume when a native continuation token is authorized', () => {
    const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
    const input = { context: {
      taskBackground: { id: 'task', title: 'Task', goal: 'background', instruction: 'background_only' as const },
      currentSubtask: { id: 'a', title: 'A', goal: 'do A', expectedOutput: 'summary' as const, acceptance: [] },
      incomingHandoffs: [], outgoingHandoffRequirements: [], selectedEvidence: [], outOfScopeSiblings: [],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: [] },
      identity: { executionId: 'e', taskId: 'task', subtaskId: 'a', attemptId: 'attempt', workUnitId: 'wu' },
      completionContract: { marker: '<!-- metaclaw:completion:v2 -->' as const, schemaVersion: 2 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'test' },
    }, recovery: { mode: 'native_session' as const, continuationToken: '019f-thread' } };
    const execution = (adapter as any).prepareExecution('continue safely', input);
    expect(execution.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(execution.args).toContain('019f-thread');
    execution.cleanup();
  });

  it('loads the Executor Codex provider env file with precedence over inherited values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-codex-env-'));
    const envFile = join(directory, 'executor-codex.env');
    writeFileSync(envFile, 'OPENAI_API_KEY=codex-file-key\nOPENAI_BASE_URL=https://codex.invalid/v1\n');
    vi.stubEnv('METACLAW_CODEX_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('OPENAI_API_KEY', 'inherited-key');

    try {
      const adapter = new CodexCliAdapter({ command: 'codex', timeout: 300 });
      const env = (adapter as any).buildSpawnEnv();
      expect(env.OPENAI_API_KEY).toBe('codex-file-key');
      expect(env.OPENAI_BASE_URL).toBe('https://codex.invalid/v1');
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
