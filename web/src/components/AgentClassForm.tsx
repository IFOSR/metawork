interface AgentClassFormProps {
  agentClasses: Record<string, Record<string, unknown>>;
  models: Record<string, Record<string, unknown>>;
  onChange: (agentClasses: Record<string, Record<string, unknown>>) => void;
}

export function AgentClassForm({ agentClasses, models, onChange }: AgentClassFormProps) {
  const update = (id: string, patch: Record<string, unknown>) => {
    onChange({ ...agentClasses, [id]: { ...agentClasses[id], ...patch } });
  };

  const modelPolicy = (agentClass: Record<string, unknown>) =>
    (agentClass.modelPolicy ?? {}) as { mode?: string; modelRef?: string };

  const modelOptions = ['auto', ...Object.keys(models)];

  return (
    <div className="form-section">
      {Object.entries(agentClasses).map(([id, agentClass]) => {
        const policy = modelPolicy(agentClass);
        return (
          <div className="form-card" key={id}>
            <div className="form-card-head">
              <span className="form-card-title">{id}</span>
              <span className="dim">{String(agentClass.kind ?? 'executor')}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(agentClass.enabled)}
                  onChange={event => update(id, { enabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="form-field">
              <span className="field-label">harnessRef</span>
              <span>{String(agentClass.harnessRef ?? '—')}</span>
            </div>
            <div className="form-field">
              <span className="field-label">modelPolicy</span>
              <select
                value={policy.modelRef ?? 'auto'}
                onChange={event => update(id, { modelPolicy: { ...policy, modelRef: event.target.value } })}
              >
                {modelOptions.map(option => (
                  <option value={option} key={option}>{option}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <span className="field-label">permissionProfileRef</span>
              <span className="mono">{String(agentClass.permissionProfileRef ?? '—')}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
