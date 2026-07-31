import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlannerProcessRunner } from '../src/planning/planner-process-runner.js';

interface FakeRpcProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function emitJson(child: FakeRpcProcess, event: Record<string, unknown>): void {
  child.stdout.write(JSON.stringify(event) + '\n');
}

function createRpcProcess(onCommand: (command: Record<string, unknown>, child: FakeRpcProcess) => void): FakeRpcProcess {
  const child = new EventEmitter() as FakeRpcProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString();
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      onCommand(JSON.parse(line) as Record<string, unknown>, child);
      newline = input.indexOf('\n');
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  return child;
}

function completeTurn(child: FakeRpcProcess, requestId: unknown, output = '{"ok":true}'): void {
  emitJson(child, { type: 'response', command: 'prompt', success: true, id: requestId });
  emitJson(child, {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'read',
    args: { path: '/workspace/CONTEXT.md' },
  });
  emitJson(child, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'read',
    result: { lines: 10 },
    isError: false,
  });
  emitJson(child, {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: output }] }],
  });
}

describe('PlannerProcessRunner', () => {
  it('uses the AnyFusion Pi RPC boundary and returns the final assistant message', async () => {
    let seen: { command: string; args: string[]; request?: Record<string, unknown> } | undefined;
    const runner = new PlannerProcessRunner({
      command: 'anyfusion-planner',
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: ((command: string, args: string[]) => {
        seen = { command, args };
        return createRpcProcess((request, child) => {
          seen = { ...seen!, request };
          completeTurn(child, request.id);
        }) as never;
      }) as never,
    });

    const result = await runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-1', source: 'session' },
    } as never);

    expect(result).toMatchObject({
      output: '{"ok":true}',
      threadId: join('/tmp/anyfusion-planner-test', 'session-1.jsonl'),
      toolCalls: [{ toolName: 'read', status: 'completed' }],
    });
    expect(seen?.command).toBe('anyfusion-planner');
    expect(seen?.args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--session']));
    expect(seen?.args).not.toContain('--provider');
    expect(seen?.args).not.toContain('--model');
    expect(seen?.args).not.toContain('--print');
    expect(seen?.request).toMatchObject({ type: 'prompt', message: 'hello' });
  });

  it('fails closed when Pi rejects prompt preflight and redacts the error', async () => {
    const runner = new PlannerProcessRunner({
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: (() => createRpcProcess((request, child) => {
        emitJson(child, {
          type: 'response',
          command: 'prompt',
          success: false,
          id: request.id,
          error: 'api_key=planner-secret Authorization: Bearer bearer-secret',
        });
      }) as never) as never,
    });

    const error = await runner.run('hello', {
      timeoutMs: 1000,
      request: { sessionId: 'session-error', source: 'gateway' },
    } as never).catch(reason => reason as Error);

    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('planner-secret');
    expect(error.message).not.toContain('bearer-secret');
  });

  it('serializes concurrent turns that target the same Pi session', async () => {
    const children: FakeRpcProcess[] = [];
    const requests: Record<string, unknown>[] = [];
    const spawn = vi.fn(() => {
      const child = createRpcProcess(request => { requests.push(request); });
      children.push(child);
      return child as never;
    });
    const runner = new PlannerProcessRunner({
      sessionDir: '/tmp/anyfusion-planner-test',
      spawn: spawn as never,
    });
    const context = {
      timeoutMs: 1000,
      request: { sessionId: 'shared-session', source: 'gateway' },
    } as never;

    const first = runner.run('first', context);
    const second = runner.run('second', context);
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
    });

    completeTurn(children[0]!, requests[0]!.id, 'first-output');
    await expect(first).resolves.toMatchObject({ output: 'first-output' });
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(2);
    });

    completeTurn(children[1]!, requests[1]!.id, 'second-output');
    await expect(second).resolves.toMatchObject({ output: 'second-output' });
  });
});
