import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const SETTINGS_ASSISTANT_DEFAULT_MODEL_ID = 'deepseek-v4.1-flash' as const;
export const SETTINGS_ASSISTANT_DEFAULT_DISPLAY_NAME = 'deepseek-flash' as const;
export const SETTINGS_ASSISTANT_DEFAULT_SECRET_REF = 'file-secret:anyfusion/internal/llm' as const;

export interface InternalSettingsAssistantConfig {
  provider: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  apiKeyRef: `keychain:${string}` | `file-secret:${string}`;
  enabled: boolean;
  timeoutMs: number;
  maxTokens?: number;
  thinking?: 'enabled' | 'disabled';
}

export const DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG: InternalSettingsAssistantConfig = {
  provider: 'deepseek',
  modelId: SETTINGS_ASSISTANT_DEFAULT_MODEL_ID,
  displayName: SETTINGS_ASSISTANT_DEFAULT_DISPLAY_NAME,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyRef: SETTINGS_ASSISTANT_DEFAULT_SECRET_REF,
  enabled: true,
  timeoutMs: 30_000,
};

const InternalConfigSchema = z.object({
  provider: z.string().trim().min(1).max(100).default('deepseek'),
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(100).default('内部 LLM'),
  baseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash;
  }),
  apiKeyRef: z.string().regex(/^(?:file-secret|keychain):anyfusion\/internal\/[a-z][a-z0-9-]{0,63}$/u)
    .default(SETTINGS_ASSISTANT_DEFAULT_SECRET_REF),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
  maxTokens: z.number().int().min(512).max(16_384).optional(),
  thinking: z.enum(['enabled', 'disabled']).optional(),
}).strict();

/** Read for each operation: developer edits take effect on the next request. */
export async function loadInternalSettingsAssistantConfig(input: {
  installRoot: string;
  fileName?: string;
}): Promise<InternalSettingsAssistantConfig> {
  try {
    return InternalConfigSchema.parse(JSON.parse(await readFile(
      join(input.installRoot, input.fileName ?? 'internal/llm.json'), 'utf8',
    ))) as InternalSettingsAssistantConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG, enabled: false };
    }
    // Never print config contents, URLs or JSON parser excerpts to a client.
    throw new Error('MetaWork 内部 LLM 配置无效，请由研发人员检查 internal/llm.json。');
  }
}

export function parseInternalSettingsAssistantConfig(value: unknown): InternalSettingsAssistantConfig {
  const parsed = InternalConfigSchema.safeParse(value);
  return parsed.success ? parsed.data as InternalSettingsAssistantConfig : DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG;
}
