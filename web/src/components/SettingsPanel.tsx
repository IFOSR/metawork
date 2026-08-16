import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';
import type { ActivateResult } from '../api/types';
import { AgentClassConfig, type AgentClassConfigDraft } from './AgentClassConfig';
import {
  OTHER_PROVIDER_KEY,
  presetProvider,
  presetProviderByBaseUrl,
} from '../preset-providers';

interface SettingsPanelProps {
  http: HttpClient | null;
  onClose: () => void;
}

type DraftState = Record<string, AgentClassConfigDraft>;

function sanitizeRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

function loadDraft(config: Record<string, unknown>): DraftState {
  const agentClasses = (config.agentClasses ?? {}) as Record<string, Record<string, unknown>>;
  const models = (config.models ?? {}) as Record<string, Record<string, unknown>>;
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;

  const draft: DraftState = {};
  for (const [ref, agentClass] of Object.entries(agentClasses)) {
    const policy = agentClass.modelPolicy as { mode?: string; modelRef?: string; defaultModelRef?: string; allowedModelRefs?: string[] };
    const modelRef = policy?.mode === 'fixed'
      ? (policy.modelRef ?? '')
      : (policy?.defaultModelRef ?? policy?.allowedModelRefs?.[0] ?? '');
    const model = models[modelRef];
    const provider = model ? providers[String(model.providerRef)] : undefined;
    const preset = provider ? presetProviderByBaseUrl(String(provider.baseUrl ?? '')) : undefined;

    draft[ref] = {
      providerKey: preset ? preset.key : OTHER_PROVIDER_KEY,
      providerName: preset ? '' : String(model?.providerRef ?? ''),
      baseUrl: preset ? preset.baseUrl : String(provider?.baseUrl ?? ''),
      apiKey: '',
      modelId: String(model?.modelId ?? ''),
    };
  }
  return draft;
}

export function SettingsPanel({ http, onClose }: SettingsPanelProps) {
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [runningRevisionId, setRunningRevisionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [result, setResult] = useState<ActivateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!http) return;
    void http.getConfig().then(snapshot => {
      const config = snapshot.config as Record<string, unknown>;
      setRevisionId(snapshot.revisionId);
      setRunningRevisionId(snapshot.runningRevisionId);
      setDraft(loadDraft(config));
    }).catch(error => setLoadError((error as Error).message));
  }, [http]);

  const activate = async () => {
    if (!http || !revisionId || !draft) return;
    setLoading(true);
    setResult(null);
    try {
      const original = await http.getConfig();
      const originalConfig = original.config as Record<string, unknown>;
      const originalAgentClasses = (originalConfig.agentClasses ?? {}) as Record<string, Record<string, unknown>>;

      const providers: Record<string, Record<string, unknown>> = {};
      const models: Record<string, Record<string, unknown>> = {};
      const agentClasses: Record<string, Record<string, unknown>> = {};

      for (const [ref, entry] of Object.entries(draft)) {
        const preset = presetProvider(entry.providerKey);
        const providerRef = preset ? preset.key : sanitizeRef(entry.providerName);
        const baseUrl = preset ? preset.baseUrl : entry.baseUrl;

        // 写凭证（Other 且用户输入了 key；预设 provider 的 key 已在安装期/SecretStore 就位）。
        if (entry.providerKey === OTHER_PROVIDER_KEY && entry.apiKey) {
          await http.writeSecret(providerRef, entry.apiKey);
        }

        providers[providerRef] = {
          protocol: 'openai-compatible',
          baseUrl,
          apiKeyRef: `file-secret:anyfusion/providers/${providerRef}`,
          region: 'international',
          enabled: true,
        };

        const modelRef = sanitizeRef(`${providerRef}-${entry.modelId}`);
        models[modelRef] = {
          modelId: entry.modelId,
          providerRef,
          capabilities: ref === 'planner' ? ['planning', 'structured-output'] : ['coding', 'tools'],
          reasoning: 'high',
          enabled: true,
        };

        agentClasses[ref] = {
          ...(originalAgentClasses[ref] ?? {}),
          modelPolicy: { mode: 'fixed', modelRef },
        };
      }

      const next = {
        ...originalConfig,
        providers,
        models,
        agentClasses,
      };
      const response = await http.activate(revisionId, next);
      setResult(response);
      if (response.ok && response.revisionId) {
        setRevisionId(response.revisionId);
      }
    } catch (error) {
      setResult({ ok: false, code: 'network', issues: [(error as Error).message] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={event => event.stopPropagation()}>
        <div className="drawer-header">
          <span className="drawer-title">
            设置 · 运行 {runningRevisionId ?? '…'} · 配置 {revisionId ?? '…'}
          </span>
          <button className="ghost-button" onClick={onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <p className="settings-note">
            直接为 Planner 和每个 Executor 选择 Provider 与 Model（级联）。
            预设 Code CLI / Kimi / DeepSeek，也可选 Other 自定义 baseUrl 与模型。
            凭证由 SecretStore 托管，revision 只含引用；激活在下次启动时生效。
          </p>
          {revisionId && runningRevisionId && revisionId !== runningRevisionId && (
            <div className="result-banner result-ok">
              配置 revision {revisionId} 已就绪；当前仍运行 {runningRevisionId}，请重启 AnyFusion 后生效。
            </div>
          )}

          {loadError && <div className="result-banner result-error">加载失败：{loadError}</div>}
          {!draft && !loadError && <div className="empty-hint">加载配置中…</div>}

          {draft && (
            <div className="form-section">
              {Object.entries(draft).map(([ref, entry]) => (
                <AgentClassConfig
                  key={ref}
                  agentClassRef={ref}
                  kind={ref === 'planner' ? 'planner' : 'executor'}
                  draft={entry}
                  onChange={next => setDraft(prev => prev ? { ...prev, [ref]: next } : prev)}
                />
              ))}

              {result && (
                <div className={`result-banner ${result.ok ? 'result-ok' : 'result-error'}`}>
                  {result.ok
                    ? result.restartRequired
                      ? `配置已激活为 ${result.activeRevisionId}；当前仍运行 ${result.runningRevisionId}，请重启 AnyFusion 后生效。`
                      : `配置已激活并生效：${result.activeRevisionId}`
                    : `激活失败（${result.code ?? 'unknown'}）`}
                  {result.issues && result.issues.length > 0 && (
                    <ul className="issues">
                      {result.issues.map((issue, index) => <li key={index}>{issue}</li>)}
                    </ul>
                  )}
                  {result.code === 'revision_conflict' && (
                    <div className="dim">配置已被其他操作更新，请关闭设置后重新打开再试。</div>
                  )}
                  {!result.ok && (
                    <div className="dim">提示：若选择了 Other，请确认已填写 Provider 名、baseUrl 与 API Key。</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {draft && (
          <div className="drawer-footer">
            <button className="ghost-button" onClick={onClose}>取消</button>
            <button className="primary-button" onClick={activate} disabled={loading}>
              {loading ? '激活中…' : '激活（重启生效）'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
