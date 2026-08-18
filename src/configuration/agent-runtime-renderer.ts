import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnyFusionConfigurationV2, ConfigurationSnapshot } from './types.js';

const CURRENT_FILE = 'current';

/**
 * Renders the revision-pinned agent runtime configuration under
 * generated/agent-runtime/<revisionId>/ and atomically switches the `current`
 * pointer. Planner and Executor homes read from `current` so a new activation
 * takes effect for new Planner sessions and new attempts without touching the
 * immutable per-revision directories.
 */
export class AgentRuntimeRenderer {
  constructor(private readonly generatedRoot: string) {}

  async render(snapshot: ConfigurationSnapshot): Promise<string> {
    const target = join(this.generatedRoot, snapshot.revisionId);
    const tmp = `${target}.tmp-${randomUUID()}`;
    await mkdir(tmp, { recursive: true });
    try {
      await this.renderPlanner(snapshot.config, tmp);
      await this.renderCodex(snapshot.config, tmp);
      await this.renderPi(snapshot.config, tmp);
      await rm(target, { recursive: true, force: true });
      await rename(tmp, target);
      await this.pointCurrent(snapshot.revisionId);
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
    return target;
  }

  async currentRevisionId(): Promise<string | null> {
    try {
      const value = await readFile(join(this.generatedRoot, CURRENT_FILE), 'utf8');
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }

  /** Resolves a runtime home under the current generated revision, or null. */
  async currentPath(segment: string): Promise<string | null> {
    const revisionId = await this.currentRevisionId();
    return revisionId ? join(this.generatedRoot, revisionId, segment) : null;
  }

  private async pointCurrent(revisionId: string): Promise<void> {
    const tmp = join(this.generatedRoot, `.${CURRENT_FILE}.tmp`);
    await writeFile(tmp, `${revisionId}\n`, 'utf8');
    await rename(tmp, join(this.generatedRoot, CURRENT_FILE));
  }

  private async renderPlanner(config: AnyFusionConfigurationV2, root: string): Promise<void> {
    const planner = join(root, 'planner');
    await mkdir(planner, { recursive: true });
    await writeFile(join(planner, 'models.json'), `${JSON.stringify(buildModelsJson(config), null, 2)}\n`, 'utf8');
    await writeFile(join(planner, 'settings.json'), `${JSON.stringify(buildSettingsJson(config, 'planner'), null, 2)}\n`, 'utf8');
  }

  private async renderPi(config: AnyFusionConfigurationV2, root: string): Promise<void> {
    const agent = join(root, 'pi-home', '.pi', 'agent');
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, 'models.json'), `${JSON.stringify(buildModelsJson(config), null, 2)}\n`, 'utf8');
    await writeFile(join(agent, 'settings.json'), `${JSON.stringify(buildSettingsJson(config, 'pi-agent'), null, 2)}\n`, 'utf8');
  }

  private async renderCodex(config: AnyFusionConfigurationV2, root: string): Promise<void> {
    const codex = join(root, 'codex');
    await mkdir(codex, { recursive: true });
    await writeFile(join(codex, 'config.toml'), buildCodexConfigToml(config), 'utf8');
  }
}

function enabledProviders(config: AnyFusionConfigurationV2): Array<[string, AnyFusionConfigurationV2['providers'][string]]> {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.enabled && provider.protocol === 'openai-compatible');
}

function enabledModelsFor(config: AnyFusionConfigurationV2, providerRef: string) {
  return Object.entries(config.models)
    .filter(([, model]) => model.enabled && model.providerRef === providerRef);
}

function apiKeyVariable(providerRef: string, providerCount: number): string {
  return providerCount === 1
    ? '$OPENAI_API_KEY'
    : `$OPENAI_API_KEY__${providerRef.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

function buildModelsJson(config: AnyFusionConfigurationV2): Record<string, unknown> {
  const providers = enabledProviders(config);
  const providerEntries: Record<string, unknown> = {};
  for (const [ref, provider] of providers) {
    providerEntries[ref] = {
      baseUrl: provider.baseUrl,
      api: 'openai-responses',
      apiKey: apiKeyVariable(ref, providers.length),
      models: enabledModelsFor(config, ref).map(([, model]) => ({
        id: model.modelId,
        reasoning: model.reasoning !== 'disabled',
        compat: {
          supportsReasoningEffort: model.reasoning === 'high' || model.reasoning === 'medium',
        },
      })),
    };
  }
  return { providers: providerEntries };
}

function resolveModelRef(config: AnyFusionConfigurationV2, agentClassId: string): string | null {
  const agentClass = config.agentClasses[agentClassId];
  if (!agentClass) return null;
  const policy = agentClass.modelPolicy;
  if (policy.mode === 'fixed') return policy.modelRef;
  return policy.defaultModelRef ?? policy.allowedModelRefs[0] ?? null;
}

function buildSettingsJson(config: AnyFusionConfigurationV2, agentClassId: string): Record<string, unknown> {
  const providers = enabledProviders(config);
  const defaultModelRef = resolveModelRef(config, agentClassId);
  const defaultModel = defaultModelRef ? config.models[defaultModelRef] : null;
  const defaultProviderRef = defaultModel?.providerRef ?? providers[0]?.[0] ?? '';
  return {
    defaultProvider: defaultProviderRef,
    defaultModel: defaultModel?.modelId ?? '',
    quietStartup: true,
    defaultProjectTrust: 'always',
    enableSkillCommands: false,
    defaultThinkingLevel: 'high',
    enabledModels: providers.flatMap(([ref]) =>
      enabledModelsFor(config, ref).map(([, model]) => `${ref}/${model.modelId}`),
    ),
  };
}

function buildCodexConfigToml(config: AnyFusionConfigurationV2): string {
  const providers = enabledProviders(config);
  const modelRef = resolveModelRef(config, 'codex-cli');
  const model = modelRef ? config.models[modelRef] : null;
  const modelProvider = model?.providerRef ?? providers[0]?.[0] ?? '';
  const lines = [
    `model = "${model?.modelId ?? ''}"`,
    `model_provider = "${modelProvider}"`,
    'model_reasoning_effort = "high"',
    'preferred_auth_method = "apikey"',
    'web_search = "disabled"',
    '',
    '[features]',
    'apps = false',
    'multi_agent = false',
    'unified_exec = false',
    'tool_suggest = false',
    'goals = false',
    'guardian_approval = false',
  ];
  for (const [ref, provider] of providers) {
    lines.push('', `[model_providers.${ref}]`);
    lines.push(`name = "${ref}"`);
    lines.push(`base_url = "${provider.baseUrl}"`);
    lines.push(providers.length === 1 ? 'env_key = "OPENAI_API_KEY"' : `env_key = "OPENAI_API_KEY__${ref.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}"`);
    lines.push('wire_api = "responses"');
    lines.push('requires_openai_auth = false');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 同步解析当前 generated runtime home 的子目录。
 * 读取 generatedRoot/current 得到当前 revisionId，返回 generatedRoot/<revisionId>/<subdir>。
 * current 缺失或目录未渲染时返回 null（调用方回退到环境变量/默认值）。
 */
export function resolveCurrentRuntimeHome(generatedRoot: string, subdir: string): string | undefined {
  try {
    const revisionId = readFileSync(join(generatedRoot, 'current'), 'utf8').trim();
    if (!revisionId) return undefined;
    return join(generatedRoot, revisionId, subdir);
  } catch {
    return undefined;
  }
}

export function resolveRevisionRuntimeHome(
  generatedRoot: string,
  revisionId: string | undefined,
  subdir: string,
): string | undefined {
  if (!revisionId) return undefined;
  const path = join(generatedRoot, revisionId, subdir);
  return existsSync(path) ? path : undefined;
}
