import {
  OTHER_PROVIDER_KEY,
  PRESET_PROVIDERS,
  presetProvider,
} from '../preset-providers';
import type { ProviderSecretState } from './provider-secret-state';

export interface AgentClassConfigDraft {
  providerKey: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export type SecretState = ProviderSecretState | 'valid' | 'invalid';

interface AgentClassConfigProps {
  agentClassRef: string;
  kind: string;
  draft: AgentClassConfigDraft;
  /** 当前选中 provider 的密钥状态；unknown 表示检查中或无法判断。 */
  secretState: SecretState;
  onChange: (draft: AgentClassConfigDraft) => void;
}

export function AgentClassConfig({
  agentClassRef,
  kind,
  draft,
  secretState,
  onChange,
}: AgentClassConfigProps) {
  const preset = presetProvider(draft.providerKey);
  const isOther = draft.providerKey === OTHER_PROVIDER_KEY;
  const providerRef = isOther
    ? draft.providerName.replace(/[^a-zA-Z0-9-]/g, '-') || '（未命名）'
    : draft.providerKey;
  const badgeText = secretState === 'configured' || secretState === 'valid' ? '本机已配置 ✓'
    : secretState === 'invalid' ? '无效，请重填'
    : secretState === 'missing' ? '未配置，必填'
    : '检查中…';
  const needsKey = secretState === 'missing';

  const selectProvider = (key: string) => {
    if (key === OTHER_PROVIDER_KEY) {
      onChange({ ...draft, providerKey: key, apiKey: '', modelId: '' });
      return;
    }
    const next = presetProvider(key);
    onChange({
      ...draft,
      providerKey: key,
      apiKey: '',
      modelId: next?.models[0] ?? '',
    });
  };

  return (
    <div className="form-card">
      <div className="form-card-head">
        <span className="form-card-title">{agentClassRef}</span>
        <span className="dim">{kind}</span>
      </div>

      <div className="form-field">
        <span className="field-label">Provider</span>
        <select value={draft.providerKey} onChange={event => selectProvider(event.target.value)}>
          {PRESET_PROVIDERS.map(provider => (
            <option value={provider.key} key={provider.key}>{provider.label}</option>
          ))}
          <option value={OTHER_PROVIDER_KEY}>Other（自定义）</option>
        </select>
      </div>

      <div className="form-field">
        <span className="field-label">Model</span>
        {isOther ? (
          <input
            className="text-input"
            value={draft.modelId}
            onChange={event => onChange({ ...draft, modelId: event.target.value })}
            placeholder="model-id"
          />
        ) : (
          <select value={draft.modelId} onChange={event => onChange({ ...draft, modelId: event.target.value })}>
            {(preset?.models ?? []).map(modelId => <option value={modelId} key={modelId}>{modelId}</option>)}
          </select>
        )}
      </div>

      {isOther && (
        <>
          <div className="form-field">
            <span className="field-label">Provider 名</span>
            <input
              className="text-input"
              value={draft.providerName}
              onChange={event => onChange({ ...draft, providerName: event.target.value })}
              placeholder="my-provider"
            />
          </div>
          <div className="form-field">
            <span className="field-label">baseUrl</span>
            <input
              className="text-input"
              value={draft.baseUrl}
              onChange={event => onChange({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
            />
          </div>
        </>
      )}

      <div className="form-field">
        <span className="field-label">
          API Key
          <span className={`secret-badge${needsKey ? ' secret-missing' : ''}${secretState === 'configured' || secretState === 'valid' ? ' secret-ok' : ''}`}>{badgeText}</span>
        </span>
        <input
          className="text-input"
          type="password"
          value={draft.apiKey}
          onChange={event => onChange({ ...draft, apiKey: event.target.value })}
          placeholder={secretState === 'configured' || secretState === 'valid'
            ? `本机已配置，留空保持现有 Key（${providerRef}）`
            : needsKey
              ? `请填写 ${providerRef} 的 API Key（激活前必须）`
              : `API Key（${providerRef}）`}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
