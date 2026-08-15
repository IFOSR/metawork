interface ProviderFormProps {
  providers: Record<string, Record<string, unknown>>;
  onChange: (providers: Record<string, Record<string, unknown>>) => void;
}

export function ProviderForm({ providers, onChange }: ProviderFormProps) {
  const update = (id: string, patch: Record<string, unknown>) => {
    onChange({ ...providers, [id]: { ...providers[id], ...patch } });
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
            <span className="mono">{String(provider.baseUrl ?? '—')}</span>
          </div>
          <div className="form-field">
            <span className="field-label">凭证</span>
            <span className="dim">{String(provider.apiKeyRef ?? '来自安装期配置')}（只读）</span>
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
    </div>
  );
}
