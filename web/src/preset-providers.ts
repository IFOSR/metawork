export interface PresetProvider {
  key: string;
  label: string;
  baseUrl: string;
  models: string[];
}

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    key: 'code-cli',
    label: 'Code CLI',
    baseUrl: 'https://www.code-cli.cn/v1',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  },
  {
    key: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    models: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3-256k'],
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro'],
  },
];

export const OTHER_PROVIDER_KEY = 'other';

export function presetProvider(key: string): PresetProvider | undefined {
  return PRESET_PROVIDERS.find(provider => provider.key === key);
}

export function presetProviderByBaseUrl(baseUrl: string): PresetProvider | undefined {
  return PRESET_PROVIDERS.find(provider => provider.baseUrl === baseUrl);
}
