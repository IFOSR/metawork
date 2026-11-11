import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ManagerAgent } from '../../src/planning/manager-host/manager-agent.js';
import { managerProviderEnv, writeManagerProviderConfig } from '../../src/planning/manager-host/provider-config.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';
import { readFileSync } from 'node:fs';

/**
 * Production-path verification for the Manager transport: render the Pi provider
 * configuration from the machine's active configuration revision (the same code
 * the Server runs) and complete one real planning turn with it.
 *
 *   METAWORK_VERIFY_REAL_TURN=1 npx vitest run tests/manual/manager-real-turn-from-config.test.ts
 */
const enabled = process.env.METAWORK_VERIFY_REAL_TURN === '1';

describe.skipIf(!enabled)('manager real turn from active configuration', () => {
  it('plans with the configuration rendered by MetaWork itself', async () => {
    const home = process.env.HOME ?? '';
    const configRoot = join(home, '.metawork', 'accounts', 'local-default', 'config');
    const repository = new FileConfigurationRepository(configRoot);
    await repository.initialize();
    const snapshot = await repository.getActiveSnapshot();
    const credentials = JSON.parse(readFileSync(join(home, '.metawork', 'credentials.json'), 'utf8'));

    const apiKeys: Record<string, string> = {};
    for (const [ref, provider] of Object.entries(snapshot.config.providers)) {
      if (!provider.enabled) continue;
      const key = credentials.providers?.[ref];
      if (typeof key === 'string' && key.trim()) apiKeys[ref] = key;
    }
    expect(Object.keys(apiKeys).length).toBeGreaterThan(0);

    const agentClassRef = Object.keys(snapshot.config.agentClasses)[0];
    const workspace = resolve('.');
    const managerHome = mkdtempSync(join(tmpdir(), 'metawork-manager-config-turn-'));
    const configDir = join(managerHome, 'config');
    const providerEnv = managerProviderEnv(snapshot.config, apiKeys);
    const written = writeManagerProviderConfig({
      configDir,
      configuration: snapshot.config,
      agentClassId: agentClassRef,
      providerSecrets: providerEnv,
    });
    expect(written.modelCount).toBeGreaterThan(0);
    expect(Object.keys(providerEnv).length).toBeGreaterThan(0);

    const agent = new ManagerAgent({
      command: process.env.METAWORK_PI_COMMAND ?? 'pi',
      args: [
        '--mode', 'rpc', '--no-session',
        '--extension', resolve('src/planning/manager-host/extension/index.ts'),
      ],
      env: {
        PATH: process.env.PATH,
        HOME: managerHome,
        PI_CODING_AGENT_DIR: configDir,
        PI_CODING_AGENT_SESSION_DIR: join(managerHome, 'sessions'),
        METAWORK_MANAGER_WORKSPACE: workspace,
        METAWORK_MANAGER_PLAN_SCHEMA: resolve('dist/planning-agent-plan-v9.schema.json'),
        ...providerEnv,
      },
      cwd: workspace,
      turnTimeoutMs: 240_000,
      onDiagnostic: line => process.stderr.write(`[pi] ${line}\n`),
    });

    const startedAt = Date.now();
    try {
      const result = await agent.plan({
        conversationId: 'verify-config-conversation',
        taskId: null,
        generationId: null,
        goal: '用一句话说明这个仓库是做什么的，不需要修改任何文件。',
        context: [],
        workspace: { root: workspace, mode: 'read_only' },
        permissionProfileRef: 'engineering',
        configurationRevision: snapshot.revisionId,
        model: { providerRef: 'config', modelRef: agentClassRef },
        tools: ['read', 'ls', 'grep', 'glob', 'submit_manager_proposal'],
      });
      const parsed = PlanningAgentPlanSchema.safeParse(result.proposal);
      process.stdout.write(`${JSON.stringify({
        durationMs: Date.now() - startedAt,
        revision: snapshot.revisionId,
        providers: Object.keys(providerEnv).length,
        models: written.modelCount,
        action: (result.proposal as { action?: string })?.action,
        usage: result.usage.length,
        valid: parsed.success,
      }, null, 2)}\n`);
      expect(parsed.success).toBe(true);
      expect(result.usage.length).toBeGreaterThan(0);
    } finally {
      await agent.close();
    }
  }, 300_000);
});
