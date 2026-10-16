import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntimeRenderer } from '../../src/configuration/agent-runtime-renderer.js';
import { resolveRuntimePrivateConfigurationBinding } from '../../src/configuration/runtime-private-binding-resolver.js';
import { buildRuntimeConfigurationView } from '../../src/configuration/projections.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';
import { LocalCliExecutorAdapter, SpawnLocalCliChildProcessRunner } from '../../src/executor/local-cli-executor-adapter.js';
import { safeHostEnvironment } from '../../src/executor/harness-driver.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V3 } from '../../src/execution/completion-protocol.js';

// Real installed CLI processes and tools; only the model/network peer is deterministic.
// Opt in because CI must provide the actual Pi and Codex distributions.
describe.runIf(process.env.METAWORK_EXECUTOR_PARITY === '1')('native Executor parity', () => {
  it.each([['pi', 'openai-compatible'], ['pi', 'openai-responses'], ['pi', 'anthropic'], ['codex', 'openai-responses']] as const)('%s/%s preserves read/write/command/network and result channels', async (kind, protocol) => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-parity-'));
    const requests: Record<string, any>[] = [];
    let networkCalls = 0;
    let command = ''; 
    const server = createServer(async (req, res) => {
      if (req.url === '/network') { networkCalls++; res.end('NETWORK_OK'); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (protocol === 'anthropic') {
        const done = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
        const event = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        event('message_start', { message: { id: 'msg_parity', type: 'message', role: 'assistant', model: 'parity', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        event('content_block_start', { index: 0, content_block: done ? { type: 'text', text: '' } : { type: 'tool_use', id: 'tool_1', name: 'bash', input: {} } });
        event('content_block_delta', { index: 0, delta: done ? { type: 'text_delta', text: 'PARITY_OK' } : { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
        event('message_stop', {});
        res.end();
      } else if (protocol === 'openai-compatible') {
        const done = body.messages.some((m: any) => m.role === 'tool');
        const tool = { index: 0, id: 'call_probe', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } };
        send({ id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: 1, model: 'parity', choices: [{ index: 0, delta: done ? { role: 'assistant', content: 'PARITY_OK' } : { role: 'assistant', tool_calls: [tool] }, finish_reason: null }] });
        send({ id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: 1, model: 'parity', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.end('data: [DONE]\n\n');
      } else {
        const done = JSON.stringify(body.input).includes('function_call_output');
        const toolName = body.tools?.find((t: any) => ['bash', 'shell', 'exec_command', 'shell_command'].includes(t.name))?.name ?? 'shell';
        const args = toolName === 'shell' ? { command: ['sh', '-c', command], timeout_ms: 10000 }
          : toolName === 'exec_command' ? { cmd: command }
          : { command, timeout_ms: 10000 };
        const item = done ? { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PARITY_OK', annotations: [] }] }
          : { id: 'fc_1', type: 'function_call', call_id: 'call_probe', name: toolName, arguments: JSON.stringify(args), status: 'completed' };
        send({ type: 'response.created', response: { id: 'resp_parity', object: 'response', status: 'in_progress', output: [] } });
        send({ type: 'response.output_item.added', output_index: 0, item });
        if (done) send({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'PARITY_OK' });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: 'resp_parity', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    command = `cat input.txt > output.txt && pwd > cwd.txt && curl -fsS http://127.0.0.1:${port}/network > network.txt`;
    const binding = { agentClassRef: 'worker', harnessRef: kind, providerRef: 'local', modelRef: 'parity', permissionProfileRef: 'standard-agent', configurationRevision: 'parity-revision' };
    const snapshot = { revisionId: binding.configurationRevision, contentHash: 'parity', config: {
      schemaVersion: 2,
      providers: { local: { protocol, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyRef: 'keychain:anyfusion/parity', enabled: true } },
      models: { parity: { providerRef: 'local', modelId: 'parity', capabilities: [], reasoning: 'disabled', enabled: true } },
      harnesses: { [kind]: { driverId: `${kind}-cli`, kind: 'executor', transport: 'local-cli', command: kind, args: [], enabled: true } },
      agentClasses: { worker: { kind: 'executor', harnessRef: kind, modelPolicy: { mode: 'fixed', modelRef: 'parity' }, permissionProfileRef: 'standard-agent', routingCapabilities: [], plannerAffordances: [], primaryUseCases: [], avoidUseCases: [], skills: [], plugins: [], mcpServers: [], enabled: true } },
      permissionProfiles: { 'standard-agent': { profileId: 'standard-agent' } }, runtimePolicy: {}, gateway: null,
    } } as unknown as ConfigurationSnapshot;
    try {
      const generatedRoot = join(root, 'generated');
      await new AgentRuntimeRenderer(generatedRoot).render(snapshot);
      const runtimeBinding = await resolveRuntimePrivateConfigurationBinding({ configuration: buildRuntimeConfigurationView(snapshot), authorizedBinding: binding,
        secretStore: { get: async () => 'local-test-key' } as never });
      const driver = kind === 'pi' ? new PiCliDriver({ generatedRuntimeRoot: generatedRoot, webExtensionSourcePath: '', pdfExtensionRoot: join(root, 'no-pdf') }) : new CodexCliDriver({ generatedRuntimeRoot: generatedRoot });
      const runner = new SpawnLocalCliChildProcessRunner({ hostEnvironment: safeHostEnvironment(process.env) });
      for (const mode of ['direct', 'metawork']) {
        const workspace = join(root, mode);
        await mkdir(workspace);
        await writeFile(join(workspace, 'input.txt'), 'isolated-input');
        if (mode === 'direct') {
          const home = await driver.materializeHome({ attemptId: mode, revisionId: snapshot.revisionId, agentClassId: 'worker', bindingFingerprint: runtimeBinding.bindingFingerprint, attemptsRoot: root, environment: { ...runtimeBinding.environment } });
          const args = kind === 'pi' ? ['--mode', 'json', '--provider', 'local', '--model', 'parity', 'Read input.txt, copy to output.txt and record cwd.txt.']
            : ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'model_provider="local"', '-c', 'model="parity"', 'Read input.txt, copy to output.txt and record cwd.txt.'];
          const result = await runner.run({ attemptId: mode, command: kind, args, cwd: workspace, environment: { ...runtimeBinding.environment, ...home.environment }, idleTimeoutMs: 20000 });
          expect(result.exitCode, result.stderr).toBe(0);
          expect(driver.parseResult(result)).toMatchObject({ success: true, output: 'PARITY_OK' });
        } else {
          const input = executorInput(mode);
          input.context.workspaceContext.workingDirectory = workspace;
          input.executionBinding!.workspacePath = workspace;
          // Historical inputs are siblings of files/, never cwd/input-*. Use
          // the model-visible readPath through the real CLI's filesystem tool.
          const inputsPath = join(root, 'selected-inputs');
          await mkdir(inputsPath);
          await writeFile(join(inputsPath, 'previous.txt'), 'isolated-input');
          input.executionBinding!.inputsPath = inputsPath;
          input.context.selectedArtifacts = [{
            ref: { kind: 'artifact', artifactId: 'prior-artifact' }, artifactId: 'prior-artifact',
            displayName: 'previous.txt', relativeInputPath: 'previous.txt', mediaType: 'text/plain', contentHash: 'fixture',
          }];
          command = `cat ../selected-inputs/previous.txt > output.txt && pwd > cwd.txt && curl -fsS http://127.0.0.1:${port}/network > network.txt`;
          input.executionBinding!.authorization = { ...binding, bindingFingerprint: authorizedExecutorBindingFingerprint(binding) };
          const adapter = new LocalCliExecutorAdapter({ agentClassId: 'worker', driver, runtimeBinding, authorizedBinding: binding, modelId: 'parity', attemptsRoot: root, idleTimeoutMs: 20000 });
          expect(await adapter.execute(input)).toMatchObject({ success: true, output: 'PARITY_OK' });
          expect(JSON.stringify(requests)).toContain('../selected-inputs/previous.txt');
          const requestCount = requests.length;
          const configFile = kind === 'pi' ? 'pi-home/.pi/agent/models.json' : 'codex/config.toml';
          await writeFile(join(generatedRoot, snapshot.revisionId, configFile), 'substituted configuration');
          expect(await adapter.execute(input)).toMatchObject({ success: false, failure: { kind: 'configuration' } });
          expect(requests).toHaveLength(requestCount);
        }
        expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('isolated-input');
        expect(await readFile(join(workspace, 'network.txt'), 'utf8')).toBe('NETWORK_OK');
        expect((await readFile(join(workspace, 'cwd.txt'), 'utf8')).trim()).toBe(await import('node:fs/promises').then(fs => fs.realpath(workspace)));
      }
      expect(networkCalls).toBe(2);
      expect(requests.length).toBeGreaterThanOrEqual(4);
      expect(requests.every(r => r.model === 'parity')).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});

function executorInput(attemptId: string): ExecutorInput {
  const workspacePath = `/workspace/${attemptId}`;
  return {
    context: {
      taskBackground: {
        id: 'task-1',
        title: 'Executor parity',
        goal: 'Read input.txt, copy to output.txt and record cwd.txt and network.txt.',
        instruction: 'background_only',
      },
      currentSubtask: {
        id: 'subtask-1',
        title: 'Local CLI adapter',
        goal: 'Read input.txt, copy to output.txt and record cwd.txt and network.txt.',
        deliveryKind: 'edit',
        requiredCapabilities: [],
        acceptance: [],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [],
      selectedEvidence: [],
      outOfScopeSiblings: [],
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: workspacePath,
        targetPaths: [workspacePath],
      },
      identity: {
        executionId: 'execution-1',
        taskId: 'task-1',
        subtaskId: 'subtask-1',
        attemptId,
        workUnitId: 'work-unit-1',
      },
      completionContract: {
        marker: COMPLETION_MARKER_V3,
        schemaVersion: 3,
      },
      evidenceTools: {
        availability: 'available',
        reason: 'unit test',
        binding: {
          mcpUrl: 'http://127.0.0.1:31000/mcp',
          jsonUrl: 'http://127.0.0.1:31000/evidence',
          bearerToken: 'evidence-token',
        },
      },
    },
    executionBinding: {
      attemptId,
      taskId: 'task-1',
      generationId: 'generation-1',
      subtaskId: 'subtask-1',
      workUnitId: 'work-unit-1',
      leaseToken: 'lease-1',
      idempotencyKey: 'dispatch-1',
      workspacePath,
      workspaceId: 'workspace-1',
      sourcePath: '/source',
      inputsPath: '/inputs',
      handoffsPath: '/handoffs',
      gitMetadataPath: null,
      controlNetwork: 'metaclaw-control',
      capabilityBinding: null,
    },
  };
}
