import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadInternalSettingsAssistantConfig } from './internal-settings-assistant-config.js';

const DEFAULT_MODEL_ID = 'deepseek-flash';

/** Prepare the installation-owned LLM before Server startup. */
export async function ensureInternalLlmProvisioned(input: {
  installRoot: string;
  sourceRoot?: string;
  modelId?: string;
}): Promise<void> {
  const installRoot = resolve(input.installRoot);
  const sourceRoot = resolve(input.sourceRoot ?? process.env.METAWORK_INTERNAL_LLM_SOURCE_ROOT ?? join(homedir(), '.metawork'));
  const modelId = input.modelId ?? DEFAULT_MODEL_ID;
  const targetConfig = join(installRoot, 'internal/llm.json');
  const targetCredentials = join(installRoot, 'internal/llm-credentials.json');
  const [configRaw, credentialsRaw] = await Promise.all([
    readFile(targetConfig, 'utf8').catch(() => null),
    readFile(targetCredentials, 'utf8').catch(() => null),
  ]);
  if (configRaw !== null || credentialsRaw !== null) {
    if (configRaw === null || credentialsRaw === null) throw new Error('Internal LLM installation files are incomplete');
    const config = await loadInternalSettingsAssistantConfig({ installRoot });
    const credentials = JSON.parse(credentialsRaw) as { internal?: { llm?: unknown } };
    if (!config.enabled || config.modelId !== modelId || typeof credentials.internal?.llm !== 'string' || !credentials.internal.llm.trim()) {
      throw new Error('Internal LLM installation is not provisioned for the required system model');
    }
    return;
  }
  const [sourceConfigRaw, sourceCredentialsRaw] = await Promise.all([
    readFile(join(sourceRoot, 'internal/llm.json'), 'utf8').catch(() => null),
    readFile(join(sourceRoot, 'internal/llm-credentials.json'), 'utf8').catch(() => null),
  ]);
  if (sourceConfigRaw === null || sourceCredentialsRaw === null) {
    throw new Error('System internal LLM is not provisioned; release installation must provide DeepSeek Flash credentials');
  }
  const config = JSON.parse(sourceConfigRaw) as Record<string, unknown>;
  const credentials = JSON.parse(sourceCredentialsRaw) as { internal?: { llm?: unknown } };
  if (config.modelId !== modelId || config.enabled !== true || typeof credentials.internal?.llm !== 'string' || !credentials.internal.llm.trim()) {
    throw new Error('System internal LLM source is not configured for DeepSeek Flash');
  }
  await mkdir(join(installRoot, 'internal'), { recursive: true, mode: 0o700 });
  await atomicJson(targetConfig, config);
  await atomicJson(targetCredentials, credentials);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
