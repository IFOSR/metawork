import { useState } from 'react';
import type {
  AgentClassRoutingDraft,
  AgentClassRoutingFacts,
  SettingsModelEntry,
  RoutingObjective,
} from '../settings-model';
import {
  describeRoutingObjective,
  evaluateModelCompatibility,
  humanizeProviderRef,
  SUGGESTED_USE_CASES,
} from '../settings-model';

interface AgentClassConfigProps {
  facts: AgentClassRoutingFacts;
  draft: AgentClassRoutingDraft;
  models: SettingsModelEntry[];
  onChange: (draft: AgentClassRoutingDraft) => void;
}

const objectiveOptions: Array<{ value: RoutingObjective; label: string }> = [
  { value: 'balanced', label: '均衡' },
  { value: 'quality', label: '质量优先' },
  { value: 'cost', label: '成本优先' },
  { value: 'latency', label: '速度优先' },
];

export function AgentClassConfig({
  facts,
  draft,
  models,
  onChange,
}: AgentClassConfigProps) {
  const enabledModels = models.filter(model => model.enabled !== false && model.capabilityState !== '缺失');
  const modelCompatibility = new Map(enabledModels.map(model => [
    model.ref,
    evaluateModelCompatibility(model, facts),
  ]));
  const selectedModels = draft.mode === 'auto'
    ? enabledModels.filter(model => draft.allowedModelRefs.includes(model.ref))
    : enabledModels.filter(model => model.ref === draft.modelRef);
  const selectedModel = selectedModels[0];
  const effectiveMode = facts.kind === 'planner' ? 'fixed' : draft.mode;
  const fixedModelAvailable = draft.mode === 'fixed'
    && enabledModels.some(model => model.ref === draft.modelRef);
  const [primaryUseCaseInput, setPrimaryUseCaseInput] = useState('');
  const [avoidUseCaseInput, setAvoidUseCaseInput] = useState('');

  const addUseCase = (list: 'primaryUseCases' | 'avoidUseCases', value: string) => {
    const trimmed = value.trim();
    if (!trimmed || draft[list].includes(trimmed)) return;
    onChange({ ...draft, [list]: [...draft[list], trimmed] });
  };

  const removeUseCase = (list: 'primaryUseCases' | 'avoidUseCases', value: string) => {
    onChange({ ...draft, [list]: draft[list].filter(item => item !== value) });
  };

  return (
    <article className="agent-route-card">
      <div className="agent-route-heading">
        <div>
          <div className="settings-eyebrow">{facts.kind === 'planner' ? 'PLANNER' : 'EXECUTOR'}</div>
          <h3>{facts.displayName}</h3>
          <p className="settings-subtitle">
            {facts.harnessLabel} · {facts.transport}
          </p>
        </div>
        <span className="system-badge">配置事实</span>
      </div>

      <div className="agent-route-facts">
        <section>
          <span className="fact-label">适合做什么</span>
          <div className="fact-list use-case-list">
            {draft.primaryUseCases.map(item => (
              <span className="fact-chip fact-chip-positive use-case-chip" key={item}>
                {item}
                <button
                  type="button"
                  className="use-case-remove"
                  aria-label={`移除 ${item}`}
                  onClick={() => removeUseCase('primaryUseCases', item)}
                >×</button>
              </span>
            ))}
            {draft.primaryUseCases.length === 0 && (
              <span className="fact-chip fact-chip-muted">未配置，系统不会据此自动路由</span>
            )}
          </div>
          <div className="use-case-editor">
            <input
              className="text-input"
              value={primaryUseCaseInput}
              placeholder="输入适用场景，如 image generation"
              onChange={event => setPrimaryUseCaseInput(event.target.value)}
            />
            <button
              className="ghost-button"
              disabled={!primaryUseCaseInput.trim()}
              onClick={() => { addUseCase('primaryUseCases', primaryUseCaseInput); setPrimaryUseCaseInput(''); }}
            >添加</button>
          </div>
          <div className="use-case-suggestions">
            {SUGGESTED_USE_CASES
              .filter(item => !draft.primaryUseCases.includes(item))
              .map(item => (
                <button
                  type="button"
                  className="suggestion-chip"
                  key={item}
                  onClick={() => addUseCase('primaryUseCases', item)}
                >+ {item}</button>
              ))}
          </div>
        </section>
        <section>
          <span className="fact-label">不适合做什么</span>
          <div className="fact-list use-case-list">
            {draft.avoidUseCases.map(item => (
              <span className="fact-chip fact-chip-negative use-case-chip" key={item}>
                {item}
                <button
                  type="button"
                  className="use-case-remove"
                  aria-label={`移除 ${item}`}
                  onClick={() => removeUseCase('avoidUseCases', item)}
                >×</button>
              </span>
            ))}
            {draft.avoidUseCases.length === 0 && (
              <span className="fact-chip fact-chip-muted">未配置</span>
            )}
          </div>
          <div className="use-case-editor">
            <input
              className="text-input"
              value={avoidUseCaseInput}
              placeholder="输入不适用场景"
              onChange={event => setAvoidUseCaseInput(event.target.value)}
            />
            <button
              className="ghost-button"
              disabled={!avoidUseCaseInput.trim()}
              onClick={() => { addUseCase('avoidUseCases', avoidUseCaseInput); setAvoidUseCaseInput(''); }}
            >添加</button>
          </div>
          <div className="use-case-suggestions">
            {SUGGESTED_USE_CASES
              .filter(item => !draft.avoidUseCases.includes(item))
              .map(item => (
                <button
                  type="button"
                  className="suggestion-chip"
                  key={item}
                  onClick={() => addUseCase('avoidUseCases', item)}
                >+ {item}</button>
              ))}
          </div>
        </section>
        <section>
          <span className="fact-label">路由所需能力</span>
          <div className="fact-list">
            {[...facts.routingCapabilities, ...facts.affordances].map(item => (
              <span className="fact-chip" key={item}>{item}</span>
            ))}
          </div>
          {facts.capabilityContracts.map(contract => (
            <p className="fact-contract" key={contract}>{contract}</p>
          ))}
        </section>
      </div>

      <div className="route-policy-panel">
        <div className="route-policy-heading">
          <div>
            <span className="fact-label">用户偏好</span>
            <strong>模型路由策略</strong>
          </div>
          {facts.kind === 'planner' ? (
            <span className="system-badge">手动固定模型</span>
          ) : (
            <select
              aria-label={`${facts.displayName} 路由模式`}
              value={draft.mode}
              onChange={event => {
                const mode = event.target.value as AgentClassRoutingDraft['mode'];
                onChange({
                  ...draft,
                  mode,
                  ...(mode === 'auto' && draft.allowedModelRefs.length === 0 && selectedModel
                    ? { allowedModelRefs: [selectedModel.ref], defaultModelRef: selectedModel.ref }
                    : {}),
                });
              }}
            >
              <option value="auto">Auto · 运行时智能选择</option>
              <option value="fixed">Fixed · 固定一个模型</option>
            </select>
          )}
        </div>

        {effectiveMode === 'auto' ? (
          <>
            <div className="route-policy-copy">
              Auto 会在选中的候选池内先做静态能力基线过滤。运行时还会由 Kernel 根据实时健康、
              容量、上下文和策略目标解析最终 concrete binding。
            </div>
            <div className="route-field">
              <span className="field-label">允许的模型池</span>
              <div className="model-pool">
                {enabledModels.map(model => {
                  const checked = draft.allowedModelRefs.includes(model.ref);
                  const compatibility = modelCompatibility.get(model.ref)!;
                  const canSelect = facts.kind === 'planner'
                    || compatibility.eligible;
                  return (
                    <label
                      className="model-option"
                      data-eligible={compatibility.eligible}
                      key={model.ref}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canSelect && !checked}
                        onChange={event => {
                          const nextAllowed = event.target.checked
                            ? [...draft.allowedModelRefs, model.ref]
                            : draft.allowedModelRefs.filter(ref => ref !== model.ref);
                          const nextDefault = nextAllowed.includes(draft.defaultModelRef)
                            ? draft.defaultModelRef
                            : nextAllowed[0] ?? '';
                          onChange({
                            ...draft,
                            allowedModelRefs: [...new Set(nextAllowed)].sort(),
                            defaultModelRef: nextDefault,
                          });
                        }}
                      />
                      <span>
                        <strong>{model.modelId}</strong>
                        <small>{humanizeProviderRef(model.providerRef)} · {model.capabilities.join(' / ') || '能力未确认'}</small>
                        <small className={compatibility.eligible ? 'model-eligible' : 'model-rejected'}>
                          {compatibility.eligible
                            ? `可参与 · 满足 ${compatibility.requiredCapabilities.join(' / ') || '基础能力'}`
                            : `排除 · 缺少 ${compatibility.missingCapabilities.join(' / ')}`}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="route-field-grid">
              <label className="route-field">
                <span className="field-label">优化目标</span>
                <select
                  value={draft.objective}
                  onChange={event => onChange({
                    ...draft,
                    objective: event.target.value as RoutingObjective,
                  })}
                >
                  {objectiveOptions.map(option => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="route-field">
                <span className="field-label">默认偏好</span>
                <select
                  value={draft.defaultModelRef}
                  onChange={event => onChange({ ...draft, defaultModelRef: event.target.value })}
                  disabled={draft.allowedModelRefs.length === 0}
                >
                  {draft.allowedModelRefs.map(ref => {
                    const model = models.find(item => item.ref === ref);
                    return <option value={ref} key={ref}>{model?.modelId ?? ref}</option>;
                  })}
                </select>
              </label>
            </div>
          </>
        ) : (
          <div className="route-field">
            <span className="field-label">固定模型</span>
            {!fixedModelAvailable && (
              <div className="route-invalid">
                当前没有可用模型，请重新选择。
              </div>
            )}
            <select
              value={fixedModelAvailable ? draft.modelRef : ''}
              onChange={event => onChange({ ...draft, modelRef: event.target.value })}
            >
              {!fixedModelAvailable && (
                <option value="">没有可用模型，请重新选择</option>
              )}
              {enabledModels.map(model => {
                const compatibility = modelCompatibility.get(model.ref)!;
                const canSelect = facts.kind === 'planner'
                  || compatibility.eligible;
                return (
                  <option
                    value={model.ref}
                    disabled={!canSelect && model.ref !== draft.modelRef}
                    key={model.ref}
                  >
                    {model.modelId} · {humanizeProviderRef(model.providerRef)}
                    {compatibility.eligible ? '' : ` · 缺少 ${compatibility.missingCapabilities.join('/')}`}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        <details className="routing-explanation">
          <summary>为什么这样路由</summary>
          <p>
            这里展示的是配置阶段可确定的能力基线。实际执行时，Kernel 还会检查 Provider/Model
            健康、Harness 兼容性、容量、上下文和可用性，最后按“{describeRoutingObjective(draft.objective)}”排序。
            这些运行时动态结果会在任务轨迹的 routing 阶段展示。
            {selectedModel
              ? ` 当前偏好模型为 ${selectedModel.modelId}（${humanizeProviderRef(selectedModel.providerRef)}）。`
              : ' 当前还没有可用模型。'}
          </p>
          <div className="routing-candidate-audit">
            {enabledModels.map(model => {
              const compatibility = modelCompatibility.get(model.ref)!;
              return (
                <div data-eligible={compatibility.eligible} key={model.ref}>
                  <span>{humanizeProviderRef(model.providerRef)} / {model.modelId}</span>
                  <strong>
                    {compatibility.eligible
                      ? '基线能力匹配'
                      : `排除：缺少 ${compatibility.missingCapabilities.join('、')}`}
                  </strong>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    </article>
  );
}
