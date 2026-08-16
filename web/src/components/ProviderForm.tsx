import { useState } from 'react';

interface ProviderFormProps {
  providers: Record<string, Record<string, unknown>>;
  onChange: (providers: Record<string, Record<string, unknown>>) => void;
}

export function ProviderForm({ providers, onChange }: ProviderFormProps) {
  const [adding, setAdding] = useState(false);
  const [newRef, setNewRef] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');

  const update = (id: string, patch: Record<string, unknown>) => {
    onChange({ ...providers, [id]: { ...providers[id], ...patch } });
  };

  const addProvider = () => {
    const ref = newRef.trim();
    if (!ref || !newBaseUrl.trim()) return;
    if (providers[ref]) return;
    onChange({
      ...providers,
      [ref]: {
        protocol: 'openai-compatible',
        baseUrl: newBaseUrl.trim(),
        apiKeyRef: '',
        region: 'international',
        enabled: true,
        // 前端草稿字段：激活时由 SettingsPanel 写 SecretStore，不进入 revision。
        _apiKeyDraft: newApiKey,
      },
    });
    setAdding(false);
    setNewRef('');
    setNewBaseUrl('');
    setNewApiKey('');
  };

  return (
    <div className="form-section">
      {Object.entries(providers).map(([id, provider]) => (
        <div className="form-card" key={id}>
          <div className="form-card-head">
            <span className="form-card-title">{id}</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(provider.enabled)}
                onChange={event => update(id, { enabled: event.target.checked })}
              />
              启用
            </label>
          </div>
          <div className="form-field">
            <span className="field-label">协议</span>
            <span>{String(provider.protocol ?? '—')}</span>
          </div>
          <div className="form-field">
            <span className="field-label">baseUrl</span>
            <input
              className="text-input"
              value={String(provider.baseUrl ?? '')}
              onChange={event => update(id, { baseUrl: event.target.value })}
            />
          </div>
          <div className="form-field">
            <span className="field-label">API Key</span>
            <input
              className="text-input"
              type="password"
              value={String(provider._apiKeyDraft ?? '')}
              placeholder={provider.apiKeyRef ? '已配置（留空保持不变）' : '新建必填'}
              onChange={event => update(id, { _apiKeyDraft: event.target.value })}
            />
          </div>
          <div className="form-field">
            <span className="field-label">region</span>
            <select
              value={String(provider.region ?? 'international')}
              onChange={event => update(id, { region: event.target.value })}
            >
              <option value="international">international</option>
              <option value="domestic">domestic</option>
            </select>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="form-card">
          <div className="form-card-head">
            <span className="form-card-title">新增 Provider</span>
          </div>
          <div className="form-field">
            <span className="field-label">ref</span>
            <input
              className="text-input"
              value={newRef}
              onChange={event => setNewRef(event.target.value)}
              placeholder="provider-a"
            />
          </div>
          <div className="form-field">
            <span className="field-label">baseUrl</span>
            <input
              className="text-input"
              value={newBaseUrl}
              onChange={event => setNewBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="form-field">
            <span className="field-label">API Key</span>
            <input
              className="text-input"
              type="password"
              value={newApiKey}
              onChange={event => setNewApiKey(event.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="form-actions">
            <button className="ghost-button" onClick={() => setAdding(false)}>取消</button>
            <button className="primary-button" onClick={addProvider}>添加</button>
          </div>
        </div>
      ) : (
        <button className="ghost-button add-button" onClick={() => setAdding(true)}>+ 新增 Provider</button>
      )}
    </div>
  );
}
