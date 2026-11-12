import { PreferredModelError, type PreferredModelReference } from './internal-llm-service.js';
import { PUBLIC_PROVIDER_PRESETS } from './public-provider-catalog.js';

export type { PreferredModelReference };

export interface PreferredModelTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly system?: string;
}

interface ResolvableProvider {
  readonly baseUrl: string;
  readonly apiKeyRef: string;
  readonly protocol: string;
  readonly enabled?: boolean;
}

/** 端点比较忽略尾斜杠与大小写；只用于公开预设的查找键。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

/** 解析结论只记录引用与分支，不记录端点、凭证或任何密钥。 */
function logResolution(
  outcome: 'active' | 'preset' | 'failed',
  reference: PreferredModelReference,
  reason?: string,
): void {
  console.warn('[MetaWork] 用户模型解析', {
    outcome,
    providerRef: reference.providerRef,
    modelId: reference.modelId,
    ...(reason ? { reason } : {}),
  });
}

/**
 * 解析”优先使用用户已配置模型”的本机传输。
 *
 * 端点只认可两类来源：已激活配置里的 Provider（含尚未激活但已在本机暂存的
 * 待激活 Provider），或官方公开预设目录。
 * 客户端提交的 baseUrl 只作为预设查找键，永远不会成为任意代理目标；
 * 凭证一律由本机凭据库解析。解析不到就抛出可操作错误，不静默回退。
 *
 * 错误文案统一指向”尚未保存激活”：用户填了 API Key 但没点保存时，密钥根本
 * 没进凭据库，报”缺少 API Key”会让用户反复重填。
 */
export async function resolvePreferredModel(input: {
  reference: PreferredModelReference;
  providers: Readonly<Record<string, ResolvableProvider | undefined>>;
  readCredential(reference: string): Promise<string | null>;
}): Promise<PreferredModelTransport> {
  const { reference } = input;
  const configured = input.providers[reference.providerRef];
  if (configured?.enabled !== false && configured?.protocol === 'openai-compatible') {
    const apiKey = await input.readCredential(configured.apiKeyRef);
    if (!apiKey) {
      logResolution('failed', reference, '凭证缺失');
      throw new PreferredModelError(
        `用户配置模型（${reference.modelId}）的 Provider 凭证尚未保存：`
        + '请在模型设置中重新填写该 Provider 的 API Key 并保存激活。',
      );
    }
    logResolution('active', reference);
    return { baseUrl: configured.baseUrl, apiKey, modelId: reference.modelId };
  }
  // 尚未激活的 Provider：端点只认可官方公开预设，凭证按 Provider 引用
  // 在本机凭据库中查找。
  const preset = PUBLIC_PROVIDER_PRESETS.find(candidate => (
    candidate.providerRef === reference.providerRef
    || normalizeBaseUrl(candidate.baseUrl) === normalizeBaseUrl(reference.baseUrl ?? '')
  ));
  if (!preset) {
    logResolution('failed', reference, '端点非公开预设且 Provider 未激活');
    throw new PreferredModelError(
      `用户配置模型（${reference.modelId}）尚未保存激活，其端点既不在已激活配置中，`
      + `也不是官方公开预设（${reference.baseUrl ?? '未提供端点'}）：`
      + '请先保存激活该 Provider，或改选已配置的模型。',
    );
  }
  const apiKey = await input.readCredential(`file-secret:anyfusion/providers/${reference.providerRef}`)
    ?? await input.readCredential(`keychain:anyfusion/providers/${reference.providerRef}`);
  if (!apiKey) {
    logResolution('failed', reference, '凭证缺失');
    throw new PreferredModelError(
      `用户配置模型（${reference.modelId}）的 ${preset.displayName} 的 API Key 尚未保存：`
      + '请在模型设置中填写该 Provider 的 API Key 并保存激活。',
    );
  }
  logResolution('preset', reference);
  return { baseUrl: preset.baseUrl, apiKey, modelId: reference.modelId };
}
