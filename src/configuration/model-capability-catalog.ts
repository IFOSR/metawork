import type { AnyFusionConfigurationV2, ModelCapability } from './types.js';

/**
 * Known Model capability facts keyed by Model ID.
 *
 * These are declarative, human-reviewed facts resolved from public model
 * documentation (provider model pages, coding-agent handbooks and release
 * notes). They are used only to complete safe, structural configuration facts;
 * the runtime still probes Providers when credentials are available.
 *
 * Capability vocabulary is the Model schema enum.
 */
export const MODEL_CAPABILITY_CATALOG: Readonly<Record<string, readonly ModelCapability[]>> = {
  // Code CLI / OpenAI GPT family
  'gpt-5.6-sol': ['coding', 'long-context', 'planning', 'structured-output', 'tools', 'vision'],
  'gpt-5.6-terra': ['coding', 'long-context', 'planning', 'structured-output', 'tools', 'vision'],
  'gpt-image-2': ['image-editing', 'image-generation', 'vision'],

  // Kimi
  'k3': ['coding', 'long-context', 'tools'],
  'kimi-for-coding': ['coding', 'long-context', 'tools', 'structured-output'],
  'kimi-for-coding-highspeed': ['coding', 'long-context', 'tools'],
  'k3-256k': ['coding', 'long-context', 'tools'],

  // DeepSeek
  'deepseek-chat': ['coding', 'long-context', 'tools'],
  'deepseek-flash': ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
  'deepseek-reasoner': ['coding', 'long-context', 'structured-output', 'tools', 'planning'],
  'deepseek-v4-flash': ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
  'deepseek-v4.1-flash': ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
  'deepseek-v4-pro': ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
  'deepseek-v4-flash-vision-exp': ['coding', 'vision', 'tools'],
};

export function knownModelCapabilities(modelId: string): string[] {
  return [...(MODEL_CAPABILITY_CATALOG[modelId] ?? [])];
}

export function mergeKnownModelCapabilities(
  modelId: string,
  capabilities: readonly ModelCapability[],
): ModelCapability[] {
  return [...new Set([
    ...capabilities,
    ...(MODEL_CAPABILITY_CATALOG[modelId] ?? []),
  ])].sort((left, right) => left.localeCompare(right));
}

/** Official endpoint facts are applied to a new draft, never to pinned revisions. */
export function prepareVerifiedModelCapabilities(input: AnyFusionConfigurationV2): AnyFusionConfigurationV2 {
  const config = structuredClone(input);
  for (const model of Object.values(config.models)) {
    const provider = config.providers[model.providerRef];
    if (!provider || !isOfficialDeepSeekVisionModel(model.modelId, provider.baseUrl)) continue;
    if (!model.capabilities.includes('vision')) model.capabilities.push('vision');
  }
  return config;
}

export function isOfficialDeepSeekVisionModel(modelId: string, baseUrl: string): boolean {
  // https://api-docs.deepseek.com/guides/vision (verified 2026-10-06).
  if (!['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash'].includes(modelId)) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com'
      && !url.username && !url.password && (!url.port || url.port === '443')
      && ['', '/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
}
