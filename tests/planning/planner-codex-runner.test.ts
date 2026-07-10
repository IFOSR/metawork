import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPlannerCodexArgs,
  CodexPlannerRunner,
  parseCodexJsonl,
} from '../../src/planning/planner-codex-runner.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

function context(): PlanningContext {
  return {
    userInput: 'continue',
    request: { sessionId: 'sess_runner', source: 'interactive' },
    permissions: {
      allowDurableTask: true,
      allowFileModification: true,
      allowExternalGateway: false,
    },
    timeoutMs: 1_234,
  };
}

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('CodexPlannerRunner', () => {
  it('uses an ephemeral read-only Codex invocation with the generated schema', () => {
    expect(buildPlannerCodexArgs('plan this', '/schema/v2.json')).toEqual(expect.arrayContaining([
      'exec',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--json',
      '--output-schema', '/schema/v2.json',
      '--disable', 'apps',
      'plan this',
    ]));
  });

  it('parses final output and sanitized MCP tool events from Codex JSONL', () => {
    const result = parseCodexJsonl([
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          tool: 'metaclaw_planner.search_tasks',
          status: 'completed',
          arguments: { query: 'prior task', token: 'must-not-leak' },
          result: { count: 2, conversationContent: 'must-not-leak' },
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"schemaVersion":2}' },
      }),
    ].join('\n'));

    expect(result.output).toBe('{"schemaVersion":2}');
    expect(result.toolCalls).toEqual([{
      sequence: 1,
      toolName: 'metaclaw_planner.search_tasks',
      status: 'completed',
      argumentsSummary: { query: 'prior task' },
      resultSummary: { count: 2 },
    }]);
  });

  it('isolates Planner CODEX_HOME and binds the trusted session into MCP environment', async () => {
    const proc = fakeProcess();
    const spawn = vi.fn(() => proc as never);
    const runner = new CodexPlannerRunner({
      spawn: spawn as never,
      codexHome: '/opt/metaclaw/codex/planner',
      schemaPath: '/opt/metaclaw/schema/v2.json',
      cwd: '/workspace',
    });

    const promise = runner.run('prompt', context());
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"ok":true}' },
    })));
    proc.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ output: '{"ok":true}', toolCalls: [] });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({
        cwd: '/workspace',
        timeout: 1_234,
        env: expect.objectContaining({
          CODEX_HOME: '/opt/metaclaw/codex/planner',
          METACLAW_PLANNER_SESSION_ID: 'sess_runner',
        }),
      }),
    );
  });

  it('fails closed when JSONL has no final agent output', () => {
    expect(() => parseCodexJsonl(JSON.stringify({ type: 'thread.started' })))
      .toThrow('did not contain a final agent message');
  });
});
