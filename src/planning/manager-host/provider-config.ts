/**
 * Manager provider configuration (ADR-0055 D6).
 *
 * The Manager runs the packaged upstream Pi, which reads `models.json` and
 * `settings.json` from its agent directory. MetaWork owns that directory, so it
 * renders both files from the active configuration revision and supplies provider
 * keys through the same variable names the configuration renderer already emits
 * (`OPENAI_API_KEY`, `OPENAI_API_KEY__<REF>`, `ANTHROPIC_API_KEY…`).
 *
 * The Manager therefore never reads a user-level Pi configuration, and deleting
 * the vendored Planner does not remove provider authentication: this replaces the
 * vendored runtime-home materialization with the Manager equivalent.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyFusionConfigurationV2 } from '../../configuration/types.js';
import { buildModelsJson, buildSettingsJson } from '../../configuration/agent-runtime-renderer.js';

/** The slice of configuration the Pi renderer needs. */
export type ManagerProviderConfiguration = Pick<
  AnyFusionConfigurationV2,
  'providers' | 'models' | 'agentClasses'
>;

export interface ManagerProviderConfigInput {
  /** Isolated Manager agent directory (the Pi `PI_CODING_AGENT_DIR`). */
  readonly configDir: string;
  readonly configuration: ManagerProviderConfiguration;
  /** AgentClass whose model policy picks the default model. */
  readonly agentClassId: string;
  /** Provider keys by variable name, already resolved from the SecretStore. */
  readonly providerSecrets: Readonly<Record<string, string>>;
}

export interface ManagerProviderConfig {
  readonly modelsPath: string;
  readonly settingsPath: string;
  /** Env the Manager process needs so `$VAR` references resolve. */
  readonly env: Readonly<Record<string, string>>;
  readonly modelCount: number;
}

export function writeManagerProviderConfig(input: ManagerProviderConfigInput): ManagerProviderConfig {
  const models = buildModelsJson(input.configuration);
  const settings = buildSettingsJson(input.configuration, input.agentClassId);
  mkdirSync(input.configDir, { recursive: true });
  const modelsPath = join(input.configDir, 'models.json');
  const settingsPath = join(input.configDir, 'settings.json');
  writeAtomic(modelsPath, models);
  writeAtomic(settingsPath, settings);
  const modelCount = Object.values((models.providers ?? {}) as Record<string, { models?: unknown[] }>)
    .reduce((total, provider) => total + (provider.models?.length ?? 0), 0);
  return { modelsPath, settingsPath, env: input.providerSecrets, modelCount };
}

/**
 * Renders the provider env for the Manager. The variable names come from the
 * same renderer that writes `models.json`, so a key can never land under a name
 * the model entry does not reference.
 */
export function managerProviderEnv(
  configuration: ManagerProviderConfiguration,
  apiKeys: Readonly<Record<string, string>>,
): Record<string, string> {
  const providers = Object.entries(configuration.providers ?? {})
    .filter((entry): entry is [string, AnyFusionConfigurationV2['providers'][string]] => entry[1].enabled)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const env: Record<string, string> = {};
  for (const [ref, provider] of providers) {
    const apiKey = apiKeys[ref]?.trim();
    if (!apiKey) continue;
    const prefix = provider.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const variable = providers.length === 1
      ? prefix
      : `${prefix}__${ref.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    env[variable] = apiKey;
  }
  return env;
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  // A leftover temporary file means an interrupted write; never leave one behind.
  rmSync(temporary, { force: true });
}
