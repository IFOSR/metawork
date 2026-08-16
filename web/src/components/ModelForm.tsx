import { useState } from 'react';
import { MODEL_CAPABILITIES } from '../config-edit';

interface ModelFormProps {
  models: Record<string, Record<string, unknown>>;
  providers: Record<string, Record<string, unknown>>;
  onChange: (models: Record<string, Record<string, unknown>>) => void;
}

export function ModelForm({ models, providers, onChange }: ModelFormProps) {
  const [adding, setAdding] = useState(false);
  const [newRef, setNewRef] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newProviderRef, setNewProviderRef] = useState('');

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

  const addModel = () => {
    const ref = newRef.trim();
    if (!ref || !newModelId.trim()) return;
    if (models[ref]) return;
    const providerRef = newProviderRef || Object.keys(providers)[0] || '';
    onChange({
      ...models,
      [ref]: {
        modelId: newModelId.trim(),
        providerRef,
        capabilities: [],
        reasoning: 'high',
        costTier: null,
        latencyTier: null,
        enabled: true,
      },
    });
    setAdding(false);
    setNewRef('');
    setNewModelId('');
    setNewProviderRef('');
  };

  const providerOptions = Object.keys(providers);

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
            <input
              className="text-input"
              value={String(model.modelId ?? '')}
              onChange={event => update(id, { modelId: event.target.value })}
            />
          </div>
          <div className="form-field">
            <span className="field-label">providerRef</span>
            {providerOptions.length > 0 ? (
              <select
                value={String(model.providerRef ?? providerOptions[0])}
                onChange={event => update(id, { providerRef: event.target.value })}
              >
                {providerOptions.map(ref => <option value={ref} key={ref}>{ref}</option>)}
              </select>
            ) : (
              <span className="dim">（无可用 Provider）</span>
            )}
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

      {adding ? (
        <div className="form-card">
          <div className="form-card-head">
            <span className="form-card-title">新增 Model</span>
          </div>
          <div className="form-field">
            <span className="field-label">ref</span>
            <input
              className="text-input"
              value={newRef}
              onChange={event => setNewRef(event.target.value)}
              placeholder="model-a"
            />
          </div>
          <div className="form-field">
            <span className="field-label">modelId</span>
            <input
              className="text-input"
              value={newModelId}
              onChange={event => setNewModelId(event.target.value)}
              placeholder="gpt-5"
            />
          </div>
          <div className="form-field">
            <span className="field-label">providerRef</span>
            <select
              value={newProviderRef || providerOptions[0] || ''}
              onChange={event => setNewProviderRef(event.target.value)}
            >
              {providerOptions.map(ref => <option value={ref} key={ref}>{ref}</option>)}
            </select>
          </div>
          <div className="form-actions">
            <button className="ghost-button" onClick={() => setAdding(false)}>取消</button>
            <button className="primary-button" onClick={addModel}>添加</button>
          </div>
        </div>
      ) : (
        <button className="ghost-button add-button" onClick={() => setAdding(true)}>+ 新增 Model</button>
      )}
    </div>
  );
}
