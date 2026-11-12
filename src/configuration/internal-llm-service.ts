import type { InternalSettingsAssistantConfig } from './internal-settings-assistant-config.js';
import type { SecretStore } from './secret-store.js';

/** 调用方指定优先使用的用户已配置模型。只含引用，凭证由装配层解析。 */
export interface PreferredModelReference {
  readonly providerRef: string;
  readonly modelId: string;
  /** 端点仅作为公开预设的查找键；装配层不会据此访问任意地址。 */
  readonly baseUrl?: string;
}

export interface InternalLlmDependencies {
  config?: InternalSettingsAssistantConfig | (() => Promise<InternalSettingsAssistantConfig>);
  secretStore?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Production MetaWork installations route fixed business operations through the official service. */
  officialAi?: (input: {
    operation: 'responsibility_rewrite' | 'model_summary' | 'capability_explanation';
    requestId?: string;
    input: unknown;
  }) => Promise<unknown>;
  /** Operations that should prefer the user's own pinned model resolve their
   *  transport here; return null to keep the official-service route. The local
   *  call is tried first and the official service remains the fallback. */
  preferredModel?: (input: {
    operation?: string;
    data: unknown;
    preferredModel?: PreferredModelReference | null;
  }) => Promise<{
    baseUrl: string;
    apiKey: string;
    modelId: string;
    system?: string;
  } | null>;
}

/** 解析用户固定模型时发现的可操作配置问题（如该模型尚未保存激活、缺 Provider
 *  凭证）：改用官方内置 AI 完成本次生成，但把原因随结果返回，让界面如实告知
 *  用户"你指定的模型没有生效"，而不是让用户误以为结果出自自己的模型。 */
export class PreferredModelError extends Error {}

/** 用户固定模型不可用时改用官方内置 AI 生成；原始原因随结果返回。 */
export interface DegradationNotice {
  /** 用户想用的模型标识。 */
  readonly modelId: string;
  /** 不可用的原因（可操作文案）。 */
  readonly reason: string;
  /** 实际使用的通道。 */
  readonly usedBy: 'official_ai';
}

/** Shared installation-owned LLM transport; no account Provider or Planner fallback. */
export class InternalLlmService {
  constructor(private readonly deps: InternalLlmDependencies) {}

  async generate(input: { action: string; operation?: 'responsibility_rewrite' | 'model_summary' | 'capability_explanation'; system?: string; data: unknown; preferredModel?: PreferredModelReference | null; onDegraded?: (notice: DegradationNotice) => void }): Promise<unknown> {
    // 用户固定模型优先：preferredModel 解析到可用模型时走本地直调；本地失败
    // 回退官方内置 AI，无官方通道则保留本地错误。
    // 解析器抛出的 PreferredModelError 同样是可操作的配置问题：改用官方内置 AI
    // 完成本次生成，并通过 onDegraded 把原因交回界面——既不阻断用户，也不掩盖
    // "你指定的模型没有生效"这一事实。
    // 两条通道都失败时，合并呈现本地直调的根因与兜底失败，避免掩盖。
    let preferred: { baseUrl: string; apiKey: string; modelId: string; system?: string } | null = null;
    let preferredError: unknown = null;
    // 记录失败直调的模型标识：错误发生在兜底分支，preferred 此刻已不可证明非空。
    let preferredModelId: string | null = null;
    // 用户想用的模型标识：解析失败时 preferred 为空，用引用里的 modelId 说明是谁没生效。
    const requestedModelId = input.preferredModel?.modelId ?? null;
    if (this.deps.preferredModel && input.operation) {
      try {
        preferred = await this.deps.preferredModel({
          operation: input.operation,
          data: input.data,
          ...(input.preferredModel ? { preferredModel: input.preferredModel } : {}),
        });
      } catch (error) {
        if (error instanceof PreferredModelError) {
          preferredError = error;
          preferred = null;
        } else {
          preferred = null;
        }
      }
    }
    if (preferred) {
      preferredModelId = preferred.modelId;
      try {
        return await this.completeOnPreferredModel(input, preferred);
      } catch (error) {
        if (!this.deps.officialAi) throw error;
        preferredError = error;
      }
    }
    if (this.deps.officialAi) {
      if (!input.operation) throw new InternalLlmError('缺少内置 AI 业务操作');
      try {
        const result = await this.deps.officialAi({ operation: input.operation, input: input.data });
        if (preferredError !== null) {
          input.onDegraded?.({
            modelId: preferredModelId ?? requestedModelId ?? '未识别模型',
            reason: preferredError instanceof Error ? preferredError.message : String(preferredError),
            usedBy: 'official_ai',
          });
        }
        // Compatibility envelope for existing local business validators, never an upstream response.
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
      } catch (error) {
        if (preferredError !== null) {
          const localReason = preferredError instanceof Error ? preferredError.message : String(preferredError);
          const fallbackReason = error instanceof Error ? error.message : String(error);
          throw new InternalLlmError(`用户配置模型（${preferredModelId ?? requestedModelId ?? '未知模型'}）本地调用失败（${localReason}），官方内置 AI 兜底亦失败（${fallbackReason}）。`);
        }
        throw error;
      }
    }
    if (preferredError !== null) throw preferredError;
    const { action } = input;
    if (!this.deps.config || !this.deps.secretStore) {
      throw new InternalLlmError(`${action}服务未配置，原内容未修改。`);
    }
    const config = typeof this.deps.config === 'function' ? await this.deps.config() : this.deps.config;
    if (!config.enabled) throw new InternalLlmError(`${action}服务未启用，原内容未修改。`);
    try {
      const apiKey = await this.deps.secretStore.get(config.apiKeyRef).catch(() => {
        throw new InternalLlmError(`${action}服务凭证不可用，请联系系统维护人员；原内容未修改。`);
      });
      if (!apiKey.trim()) throw new InternalLlmError(`${action}服务凭证不可用；原内容未修改。`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(
          `${config.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
            body: JSON.stringify({
              // 不发 temperature 等采样参数：部分固定订阅模型只接受特定值
              // （如 kimi-for-coding 仅接受 temperature=1），参数交由 Provider 默认值。
              model: config.modelId, max_tokens: config.maxTokens ?? 2_048,
              ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
              messages: [
                { role: 'system', content: input.system ?? 'Return a JSON business result for the supplied data.' },
                { role: 'user', content: JSON.stringify(input.data) },
              ],
            }),
          },
        );
        if (!response.ok) throw new InternalLlmError(`${action}服务请求失败（HTTP ${response.status}），原内容未修改。`);
        return await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw new InternalLlmError(`${action}超时，请重试；原内容未修改。`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof InternalLlmError) throw error;
      throw new InternalLlmError(`${action}服务暂时无法连接或响应异常，请重试；原内容未修改。`);
    }
  }
  private async completeOnPreferredModel(
    input: { action: string; system?: string; data: unknown },
    model: { baseUrl: string; apiKey: string; modelId: string; system?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(
        `${model.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
          signal: controller.signal,
          // 不发 temperature 等采样参数：部分固定订阅模型（如 kimi-for-coding）
          // 只接受特定值，参数交由 Provider 默认值。
          body: JSON.stringify({
            model: model.modelId,
            messages: [
              { role: 'system', content: model.system ?? input.system ?? 'Return a JSON business result for the supplied data.' },
              { role: 'user', content: JSON.stringify(input.data) },
            ],
          }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

class InternalLlmError extends Error {}
