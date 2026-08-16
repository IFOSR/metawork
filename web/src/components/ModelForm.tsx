import { MODEL_CAPABILITIES } from '../config-edit';

interface ModelFormProps {
  models: Record<string, Record<string, unknown>>;
  onChange: (models: Record<string, Record<string, unknown>>) => void;
}

export function ModelForm({ models, onChange }: ModelFormProps) {
  const update = (id: string, patch: Record<string, unknown>) => {
    onChange({ ...models, [id]: { ...models[id], ...patch } });
  };

  const toggleCapability = (id: string, capability: string) => {
    const current = (models[id].capabilities as string[]) ?? [];
    const next = current.includes(capability)
      ? current.filter(item => item !== capability)
      : [...current, capability];
    update(id, { capabilities: next });
  };

  return (
    <div className="form-section">
      {Object.entries(models).map(([id, model]) => (
        <div className="form-card" key={id}>
          <div className="form-card-head">
            <span className="form-card-title">{id}</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(model.enabled)}
                onChange={event => update(id, { enabled: event.target.checked })}
              />
              启用
            </label>
          </div>
          <div className="form-field">
            <span className="field-label">modelId</span>
            <span className="mono">{String(model.modelId ?? id)}（只读）</span>
          </div>
          <div className="form-field">
            <span className="field-label">providerRef</span>
            <span>{String(model.providerRef ?? '—')}</span>
          </div>
          <div className="form-field">
            <span className="field-label">reasoning</span>
            <select
              value={String(model.reasoning ?? 'medium')}
              onChange={event => update(id, { reasoning: event.target.value })}
            >
              <option value="disabled">disabled</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
          <div className="form-field">
            <span className="field-label">capabilities</span>
            <span className="chips">
              {MODEL_CAPABILITIES.map(capability => (
                <button
                  type="button"
                  key={capability}
                  className={`chip ${((model.capabilities as string[]) ?? []).includes(capability) ? 'chip-on' : ''}`}
                  onClick={() => toggleCapability(id, capability)}
                >
                  {capability}
                </button>
              ))}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
