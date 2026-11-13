import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ManagerAgent } from '../../src/planning/manager-host/manager-agent.js';
import { PlanningAgentPlanSchema } from '../../src/planning/planning-agent-plan-schema.js';

/**
 * Real Manager planning turn against the provider configured on this machine
 * (P2-B4 acceptance). Opt-in: it spends real tokens and needs network access.
 *
 *   METAWORK_VERIFY_REAL_TURN=1 npx vitest run tests/manual/manager-real-turn.test.ts
 *
 * The run is fully isolated: temp HOME/config/session roots and an explicit
 * models.json, so the user's own Pi home is never read or written.
 */
const enabled = process.env.METAWORK_VERIFY_REAL_TURN === '1';
const extension = resolve('src/planning/manager-host/extension/index.ts');

function readProvider() {
  const home = process.env.HOME ?? '';
  const accountRoot = join(home, '.metawork', 'accounts', 'local-default', 'config');
  // `active` is a symlink to the revision directory, not a file.
  const active = realpathSync(join(accountRoot, 'active'));
  const credentials = JSON.parse(readFileSync(join(home, '.metawork', 'credentials.json'), 'utf8'));
  const planner = JSON.parse(readFileSync(join(active, 'planner.json'), 'utf8'));
  const modelRef = planner.planner?.modelPolicy?.modelRef ?? 'default-model';
  const model = planner.models.find((entry: { id: string }) => entry.id === modelRef);
  const apiKey = credentials.providers?.[model.providerRef];
  if (!apiKey) throw new Error(`no credential for provider ${model.providerRef}`);
  return { providerRef: model.providerRef as string, modelRef: modelRef as string, apiKey: apiKey as string };
}

describe.skipIf(!enabled)('real Manager planning turn', () => {
  const created: ManagerAgent[] = [];
  afterAll(async () => {
    for (const agent of created) await agent.close();
  });

  it('produces a schema-valid plan and reports usage', async () => {
    const provider = readProvider();
    const workspace = resolve('.');
    const home = mkdtempSync(join(tmpdir(), 'metawork-manager-turn-'));
    const configDir = join(home, 'config');
    const sessionDir = join(home, 'sessions');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const apiModelId = process.env.METAWORK_VERIFY_MODEL ?? 'deepseek-flash';
    writeFileSync(join(configDir, 'models.json'), JSON.stringify({
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: {
        'metawork-verify': {
          baseUrl: 'https://api.deepseek.com/v1',
          api: 'openai-completions',
          apiKey: provider.apiKey,
          models: [{ id: apiModelId, name: apiModelId }],
        },
      },
    }));
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'metawork-verify',
      defaultModel: apiModelId,
      quietStartup: true,
    }));

    const passthrough = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
    const env: NodeJS.ProcessEnv = {};
    for (const key of passthrough) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.HOME = home;
    env.PI_CODING_AGENT_DIR = configDir;
    env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    env.METAWORK_MANAGER_HOST_PROTOCOL = '1';
    env.PI_TELEMETRY = 'off';
    env.METAWORK_MANAGER_WORKSPACE = workspace;
    // The extension tells the model the canonical Plan contract; without it the
    // model invents its own shape (observed on the first real run).
    env.METAWORK_MANAGER_PLAN_SCHEMA = resolve('dist/planning-agent-plan-v9.schema.json');

    const agent = new ManagerAgent({
      command: process.env.METAWORK_PI_COMMAND ?? 'pi',
      args: ['--mode', 'rpc', '--no-session', '--extension', extension],
      env,
      cwd: workspace,
      turnTimeoutMs: 240_000,
      onDiagnostic: line => process.stderr.write(`[pi] ${line}\n`),
    });
    created.push(agent);

    const goal = '用一句话说明这个仓库是做什么的，不需要修改任何文件。';
    const startedAt = Date.now();
    const result = await agent.plan({
      conversationId: 'verify-conversation',
      taskId: null,
      generationId: null,
      goal,
      context: [`用户：${goal}`],
      workspace: { root: workspace },
      permissionProfileRef: 'engineering',
      configurationRevision: 'verify-revision',
      model: { providerRef: provider.providerRef, modelRef: provider.modelRef },
      tools: ['read', 'ls', 'grep', 'glob', 'submit_manager_proposal'],
    });
    const durationMs = Date.now() - startedAt;

    const parsed = PlanningAgentPlanSchema.safeParse(result.proposal);
    process.stdout.write(`${JSON.stringify({
      durationMs,
      model: apiModelId,
      action: (result.proposal as { action?: string })?.action,
      schemaVersion: (result.proposal as { schemaVersion?: number })?.schemaVersion,
      usage: result.usage,
      valid: parsed.success,
      issues: parsed.success ? [] : parsed.error.issues.slice(0, 5),
      proposal: JSON.stringify(result.proposal).slice(0, 400),
    }, null, 2)}\n`);

    expect(result.usage.length).toBeGreaterThan(0);
    expect(parsed.success).toBe(true);
  }, 300_000);
});
