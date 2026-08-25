export interface PublicProviderPreset {
  providerRef: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
}

export const PUBLIC_PROVIDER_PRESETS: readonly PublicProviderPreset[] = [
  {
    providerRef: 'code-cli',
    displayName: 'Code CLI',
    baseUrl: 'https://www.code-cli.cn/v1',
    modelIds: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  },
  {
    providerRef: 'kimi',
    displayName: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    modelIds: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3-256k'],
  },
  {
    providerRef: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelIds: [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ],
  },
];

export function publicProviderDisplayName(providerRef: string, baseUrl?: string): string {
  const preset = PUBLIC_PROVIDER_PRESETS.find(candidate => (
    candidate.providerRef === providerRef
    || (baseUrl !== undefined && candidate.baseUrl === baseUrl)
  ));
  return preset?.displayName ?? publicDisplayNameFromRef(providerRef);
}

export function publicDisplayNameFromRef(ref: string): string {
  if (!ref) return '';
  const tail = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  const words = tail.split(/[-_.]+/u).filter(Boolean);
  return words.map(word => {
    const lower = word.toLocaleLowerCase();
    if (lower === 'cli') return 'CLI';
    if (lower === 'api') return 'API';
    if (lower === 'mcp') return 'MCP';
    if (lower === 'ai') return 'AI';
    if (lower === 'codex') return 'Codex';
    if (lower === 'openai') return 'OpenAI';
    if (lower === 'deepseek') return 'DeepSeek';
    if (lower === 'anyfusion') return 'AnyFusion';
    return word.charAt(0).toLocaleUpperCase() + word.slice(1);
  }).join(' ') || tail;
}
