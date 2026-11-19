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
        // 没有官方兜底时同样只给一句简短提示；原始原因写日志。
        console.error(`[internal-llm] model call failed: ${errorMessageOf(error)}`);
        if (!this.deps.officialAi) throw new InternalLlmError('模型调用失败，请稍后重试。');
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
          // 用户侧只给一句简短提示；两条通道各自的完整原因（含上游原文）写服务端
          // 日志，诊断看日志、界面不刷细节。
          const localReason = errorMessageOf(preferredError);
          const fallbackReason = errorMessageOf(error);
          console.error(
            `[internal-llm] model call failed: local=${localReason} fallback=${fallbackReason}`,
          );
          throw new InternalLlmError('模型调用失败，请稍后重试。');
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
    // 首次调用是全冷链路（新 Pod 首次 DNS/TCP/TLS + 供应商网关冷启动），60 秒
    // 预算可能不够：超时后网关已热，自动重试一次即可命中（仅对超时重试，HTTP
    // 4xx/5xx 是确定性问题不重试）。
    for (let attempt = 1; attempt <= 2; attempt++) {
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
              // 必须显式限制输出长度：省略 max_tokens 时服务商会按模型最大输出
              // （部分供应商 100K+）核算 TPM 配额并直接 429 拒绝，尽管实际产出
              // 只有几千 token。业务产出契约本身也是几百到几千 token。
              max_tokens: 4_096,
              messages: [
                { role: 'system', content: model.system ?? input.system ?? 'Return a JSON business result for the supplied data.' },
                { role: 'user', content: JSON.stringify(input.data) },
              ],
            }),
          },
        );
        if (!response.ok) {
          // 429 是配额/频率被拒：立刻重试只会再消耗一次配额、让限流更严重，
          // 不自动重试——如实告诉用户「上游限流，请稍后重试」。超时才重试（那是
          // 链路冷启动的暂时性问题）。
          // 带上上游原文的一小段：厂商会写明是速率超限还是额度耗尽，用户据此
          // 判断该等还是该提额。
          const excerpt = await readErrorExcerpt(response);
          throw new Error(`HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`);
        }
        return await response.json();
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (attempt < 2 && aborted) continue;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('模型调用未执行');
  }
}

class InternalLlmError extends Error {}

/** 错误原文（仅用于服务端诊断，不直接呈现给用户）。 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读上游错误响应的一小段原文（≤ 200 字，单行）。
 *
 * 上游会写明拒绝的真实原因，分类限流要靠它：
 *   - `exceeded_current_quota_error` / `quota` / `额度` / `月度用量上限`
 *     → **额度用尽**（等下个计费周期或加购，重试无用）；
 *   - `rate_limit` / `速率` / `频率` / `Throttling.RateQuota`
 *     → **速率超限**（等一会儿即可）。
 */
async function readErrorExcerpt(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/gu, ' ').trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}

/** 从上游原文里取出人能看懂的一句（厂商 message/code），不整段回显。 */
export function upstreamHint(text: string): string {
  const raw = String(text ?? '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : '';
    const type = typeof error.type === 'string' ? error.type : '';
    const code = typeof error.code === 'string' ? error.code : '';
    const hint = message || type || code;
    return hint ? hint.replace(/\s+/gu, ' ').slice(0, 120) : '';
  } catch {
    return raw.replace(/\s+/gu, ' ').slice(0, 120);
  }
}

/** 上游拒绝原因分类：额度用尽 / 速率超限 / 其它。 */
export function classifyUpstreamRejection(text: string): 'quota' | 'rate' | 'other' {
  const raw = String(text ?? '');
  if (/exceeded_current_quota_error|allocation.?quota|quota|额度|余额|monthly usage|billing cycle|purchase extra/iu.test(raw)) return 'quota';
  if (/rate.?limit|too many requests|速率|频率|throttl/iu.test(raw)) return 'rate';
  return 'other';
}

/**
 * 把失败原因归类成用户可操作的一句话：超时、凭据问题、未登录官方账号、权益失效、
 * 上游 HTTP 状态、其他。不回显上游原始报文。
 */
export function classifyCallFailure(reason: string): string {
  const text = String(reason ?? '');
  if (/未找到本机 Web|登录 MetaWork 官方账号|session_invalid|未登录官方账号/iu.test(text)) {
    return '未登录官方账号，请先在控制台点「进入实例」完成登录';
  }
  if (/entitlement_inactive|权益|订阅已过期|revoked/iu.test(text)) {
    return '官方账号权益不可用';
  }
  if (/超时|aborted|AbortError|ETIMEDOUT/iu.test(text)) {
    return '请求超时，请重试';
  }
  if (/429|too many requests|throttl/iu.test(text)) {
    // 上游原文已经说明是额度用尽还是速率超限：两种都不是「等一下就好」的同一种事，
    // 用户据此决定等下个计费周期（额度）还是降低并发（速率）。
    const kind = classifyUpstreamRejection(text);
    const hint = upstreamHint(text);
    if (kind === 'quota') return `上游额度已用尽${hint ? `（${hint}）` : ''}，需等待计费周期重置或加购用量`;
    if (kind === 'rate') return `上游速率超限${hint ? `（${hint}）` : ''}，请稍后重试`;
    return '上游限流，请稍后重试';
  }
  if (/暂时无法连接|ECONNREFUSED|fetch failed|ENOTFOUND/iu.test(text)) {
    return '无法连接上游服务，请检查网络或端点地址';
  }
  const status = /HTTP (\d{3})/u.exec(text);
  if (status) {
    return status[1] === '401' || status[1] === '403'
      ? `上游拒绝请求（HTTP ${status[1]}），请检查 API Key 或端点地址`
      : `上游返回 HTTP ${status[1]}`;
  }
  if (/模型|model/iu.test(text)) {
    return '上游未接受该模型，请检查模型 ID';
  }
  return '调用失败，请检查模型配置';
}
