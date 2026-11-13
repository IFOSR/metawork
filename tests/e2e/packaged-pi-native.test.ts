import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stagePackagedPi } from '../../scripts/lib/packaged-pi.mjs';
import { assertPiRuntimePin } from '../../scripts/lib/pi-runtime-pin.mjs';
import { verifyExecutorPi } from '../../apps/desktop/packaging/verify-executor-pi.mjs';
import { ManagerAgent } from '../../src/planning/manager-host/manager-agent.js';
import { buildManagerEnvironment } from '../../src/planning/manager-host/environment.js';
import { writeManagerMcpConfig } from '../../src/planning/manager-host/mcp-config.js';

// Real upstream process and extension, deterministic HTTP model. No credentials,
// network model calls or personal Pi configuration are used by this acceptance.
describe.skipIf(process.env.RUN_PACKAGED_PI_E2E !== '1')('native packaged upstream Pi', () => {
  it('serves Manager RPC and Executor JSON from the same relocated distribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-pi-native-'));
    const requests: Array<Record<string, any>> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); requests.push(input);
      const manager = input.tools?.some((tool: any) => tool.function?.name === 'submit_manager_proposal');
      const summary = JSON.stringify(input.messages).includes('MetaWork Manager final synthesis');
      const latestUser = input.messages.findLastIndex((message: any) => message.role === 'user');
      const toolDone = input.messages.slice(latestUser + 1).some((message: any) => message.role === 'tool');
      const contextAvailable = input.tools?.some((tool: any) => tool.function?.name === 'read_metawork_context');
      const contextDone = input.messages.slice(latestUser + 1).some((message: any) => message.role === 'tool'
        && JSON.stringify(message.content).includes('native-memory'));
      const proposalDone = input.messages.slice(latestUser + 1).some((message: any) => message.role === 'tool'
        && JSON.stringify(message.content).includes('proposal recorded'));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
        id: `review-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'review-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      emit({ role: 'assistant' });
      if (manager && contextAvailable && !contextDone) {
        emit({ tool_calls: [{ index: 0, id: 'context-1', type: 'function', function: {
          name: 'read_metawork_context', arguments: JSON.stringify({ method: 'get_memory_context' }),
        } }] });
        emit({}, 'tool_calls');
      } else if (manager && !(contextAvailable ? proposalDone : toolDone)) {
        emit({ tool_calls: [{ index: 0, id: 'proposal-1', type: 'function', function: {
          name: 'submit_manager_proposal', arguments: JSON.stringify({ proposal: summary
            ? { answer: 'Manager compared both certified markers.' }
            : { verdict: 'grant', reason: 'fixture', grantedScope: 'once' } }),
        } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ content: 'native-pi-review-ok' }); emit({}, 'stop');
      }
      response.write(`data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', choices: [],
        usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture bind failed');
    const config = join(root, 'config'); await mkdir(config);
    const mcpEntry = join(root, 'context-fixture.mjs');
    await writeFile(mcpEntry, `
      import { McpServer } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/mcp.js')).href)};
      import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/stdio.js')).href)};
      const server = new McpServer({name:'fixture',version:'1'});
      server.registerTool('get_memory_context',{inputSchema:{}},async()=>({content:[{type:'text',text:JSON.stringify({
        marker:'native-memory',conversation:process.env.METACLAW_PLANNER_CONVERSATION_ID,
        revision:process.env.METACLAW_CONFIGURATION_REVISION,providerSecret:process.env.MW_TEST_PROVIDER_SECRET ?? null
      })}]}));
      await server.connect(new StdioServerTransport());
    `);
    const mcp = writeManagerMcpConfig({configDir:config,serverEntry:mcpEntry,env:{}});
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { review: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture-only',
      models: [{ id: 'review-model', name: 'Review', reasoning: false, input: ['text'],
        contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, defaultThinkingLevel: 'off' }));
    const tool = join(root, 'relocated path/executor');
    let agent: ManagerAgent | undefined;
    try {
      await stagePackagedPi(assertPiRuntimePin(), tool);
      const command = join(tool, 'bin/pi');
      const { env } = buildManagerEnvironment({ managerHome: root, configDir: config,
        sessionDir: join(root, 'sessions'), explicit: { METAWORK_MANAGER_MCP_CONFIG: mcp.path,
          MW_TEST_PROVIDER_SECRET: 'must-not-reach-read-service' } });
      verifyExecutorPi(command, { cwd: root, env });
      agent = new ManagerAgent({ command, args: ['--mode', 'rpc', '--extension',
        join(process.cwd(), 'src/planning/manager-host/extension/index.ts')], env, cwd: root,
        sessionDir: join(root, 'sessions'),
        turnTimeoutMs: 20_000, onDiagnostic: line => process.stderr.write(`${line}\n`),
      });
      const result = await agent.plan({ conversationId: 'native-review', taskId: null, generationId: null,
        goal: 'Judge this fixture permission', context: [], workspace: { root },
        permissionProfileRef: 'review', configurationRevision: 'review-r1', purpose: 'permission',
        model: { providerRef: 'review', modelRef: 'review-model' }, tools: ['submit_manager_proposal'],
      });
      expect(result.proposal).toMatchObject({ verdict: 'grant' });
      expect(result.assistantReply).toBe('native-pi-review-ok');
      const synthesized = await agent.plan({
        conversationId: 'dialogue-summary', taskId: 'task-summary', generationId: null,
        goal: 'Compare the two markers',
        context: ['Certified Subtask 1: MW-EXACT', 'Certified Subtask 2: MW-FINAL'],
        workspace: { root }, permissionProfileRef: 'review',
        configurationRevision: 'review-r1', purpose: 'summary',
        model: { providerRef: 'review', modelRef: 'review-model' }, tools: ['submit_manager_proposal'],
      });
      expect(synthesized.proposal).toEqual({ answer: 'Manager compared both certified markers.' });
      expect(result.usage.some(usage => usage.inputTokens === 17 && usage.outputTokens === 3)).toBe(true);
      expect(requests[0]!.tools.map((item: any) => item.function.name)).toEqual(['submit_manager_proposal']);
      const planningTurn = { conversationId: 'dialogue-a', taskId: null, generationId: null,
        goal: 'Preserve the exact file content: MW-NATIVE-DIALOGUE-MARKER', context: [],
        workspace: { root }, permissionProfileRef: 'review',
        configurationRevision: 'review-r1', model: { providerRef: 'review', modelRef: 'review-model' },
        tools: ['submit_manager_proposal'] };
      await agent.plan(planningTurn);
      const contextReplies = requests.flatMap(request => request.messages)
        .filter(message => message.role === 'tool' && JSON.stringify(message.content).includes('native-memory'));
      expect(contextReplies.length).toBeGreaterThan(0);
      expect(JSON.stringify(contextReplies)).toContain('review-r1');
      expect(JSON.stringify(contextReplies)).not.toContain('must-not-reach-read-service');
      const beforeContinuation = requests.length;
      await agent.plan({ ...planningTurn, goal: 'Confirmed, continue with that exact content.' });
      expect(JSON.stringify(requests[beforeContinuation]!.messages)).toContain('MW-NATIVE-DIALOGUE-MARKER');
      const beforeOther = requests.length;
      await agent.plan({ ...planningTurn, conversationId: 'dialogue-b', goal: 'An unrelated request' });
      expect(JSON.stringify(requests[beforeOther]!.messages)).not.toContain('MW-NATIVE-DIALOGUE-MARKER');
      const beforePermission = requests.length;
      await agent.plan({ ...planningTurn, purpose: 'permission', goal: 'Judge a fresh permission request' });
      expect(JSON.stringify(requests[beforePermission]!.messages)).not.toContain('MW-NATIVE-DIALOGUE-MARKER');
      const sessionFiles = (await readdir(join(root, 'sessions'), { recursive: true })).filter(name => name.endsWith('.jsonl'));
      expect(sessionFiles).toHaveLength(2);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(command, ['--mode', 'json', '--no-session', '--tools', 'read',
          '--provider', 'review', '--model', 'review-model', '-p', 'Return native-pi-review-ok'], { cwd: root, env });
        child.stdin.end();
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Executor timeout: ${stderr} ${stdout.slice(-4000)}; requests=${requests.length}`)); }, 20_000);
        child.stdout.on('data', data => { stdout += String(data); });
        child.stderr.on('data', data => { stderr += String(data); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Executor ${code}: ${stderr}`)); });
      });
      expect(output).toContain('native-pi-review-ok');
      expect(requests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await agent?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
