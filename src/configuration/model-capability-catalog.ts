import type { ModelCapability } from './types.js';

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
  'deepseek-reasoner': ['coding', 'long-context', 'structured-output', 'tools', 'planning'],
  'deepseek-v4-flash': ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
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
