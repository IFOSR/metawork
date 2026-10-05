import type { InternalSettingsAssistantConfig } from './internal-settings-assistant-config.js';
import type { SecretStore } from './secret-store.js';

export interface InternalLlmDependencies {
  config: InternalSettingsAssistantConfig | (() => Promise<InternalSettingsAssistantConfig>);
  secretStore: SecretStore;
  fetchImpl?: typeof fetch;
}

/** Shared installation-owned LLM transport; no account Provider or Planner fallback. */
export class InternalLlmService {
  constructor(private readonly deps: InternalLlmDependencies) {}

  async generate(input: { action: string; system: string; data: unknown }): Promise<unknown> {
    const { action } = input;
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
              model: config.modelId, temperature: 0, max_tokens: config.maxTokens ?? 2_048,
              ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
              messages: [
                { role: 'system', content: input.system },
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
}

class InternalLlmError extends Error {}
