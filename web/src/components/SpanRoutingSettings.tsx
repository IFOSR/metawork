import type { SpanRoutingDraft } from '../config-edit';
import type { SettingsModelEntry, SettingsProviderEntry } from '../settings-model';

export interface SpanRoutingSettingsProps {
  draft: SpanRoutingDraft;
  models: Record<string, SettingsModelEntry>;
  providers: Record<string, SettingsProviderEntry>;
  credentialConfigured: boolean;
  editingDisabled: boolean;
  onChange(next: SpanRoutingDraft): void;
}

/**
 * Only models that declare the single supported System One/Jev decision
 * contract can be selected. Ordinary chat models are executor models, not
 * MetaWork decision models.
 */
export function selectableDecisionModels(
  models: Record<string, SettingsModelEntry>,
  providers: Record<string, SettingsProviderEntry>,
) {
  return Object.values(models)
    .filter(model => model.enabled !== false)
    .filter(model => providers[model.providerRef]?.enabled !== false)
    .filter(hasSystemOneDecisionCapability)
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}

export function hasConfirmedDecisionModelCapability(model: SettingsModelEntry): boolean {
  return hasSystemOneDecisionCapability(model);
}

function hasSystemOneDecisionCapability(model: SettingsModelEntry): boolean {
  return model.publicFacts?.outputModalities.some(item => item.toLowerCase() === 'decisions') === true
    || /(?:\/v1\/systemone|system\s*one|systemone|typesafe[\s\S]{0,80}\bjev\b|\bjev\b[\s\S]{0,80}(?:interface|protocol|接口|契约|共用))/iu.test(
      `${model.description ?? ''} ${model.routingNotes?.summary ?? ''}`,
    )
    || model.modelId === 'inception/mercury-decide:free'
    || /(?:^|[/:_-])mercury-decide(?:$|[/:_-])/iu.test(model.modelId);
}

export function SpanRoutingSettings({ draft, models, providers, credentialConfigured, editingDisabled, onChange }: SpanRoutingSettingsProps) {
  const options = selectableDecisionModels(models, providers);
  const selected = options.find(model => model.ref === draft.modelRef);
  const configured = Boolean(draft.providerRef && draft.modelRef && selected);
  const primaryProviderModels = options.filter(model => model.providerRef === draft.providerRef);
  const fallbacks = draft.fallbackModelRefs
    .map(ref => options.find(model => model.ref === ref))
    .filter((model): model is SettingsModelEntry => Boolean(model));

  return (
    <section className="settings-section system-routing-settings" aria-labelledby="decision-model-heading">
      <div className="section-heading">
        <div>
          <div className="settings-eyebrow">SYSTEM ROUTING</div>
          <h3 id="decision-model-heading">系统路由</h3>
          <p>决策模型在 Planner 完成 DAG 后联合选择 AgentClass 和 Model。凭证复用 Provider 配置，设置只影响后续新 Graph。</p>
        </div>
        <span className={`state-badge${configured ? '' : ' state-badge-warning'}`}>{configured ? '可用' : '配置未完成'}</span>
      </div>
      <div className="decision-model-explainer"><p>候选先经过权限、能力、上下文和健康状态检查；只有多个合法候选时才调用主决策模型。单一候选直接使用，不增加等待。</p></div>
      <div className="system-routing-fields">
        <label className="settings-field">
          <span>主决策 Provider</span>
          <select className="text-input" value={draft.providerRef} disabled={editingDisabled} onChange={event => {
            const providerRef = event.target.value;
            const nextModel = options.find(model => model.providerRef === providerRef);
            onChange({ ...draft, enabled: true, providerRef, modelRef: nextModel?.ref ?? '', model: nextModel?.modelId ?? draft.model });
          }}>
            <option value="">选择已配置 Provider</option>
            {[...new Set(options.map(model => model.providerRef))].map(providerRef => <option key={providerRef} value={providerRef}>{providers[providerRef]?.displayName ?? providerRef}</option>)}
          </select>
        </label>
        <label className="settings-field">
          <span>主决策 Model</span>
          <select className="text-input" value={draft.modelRef} disabled={editingDisabled || !draft.providerRef} onChange={event => {
            const model = models[event.target.value];
            onChange({ ...draft, enabled: true, modelRef: event.target.value, model: model?.modelId ?? draft.model });
          }}>
            <option value="">选择决策 Model</option>
            {primaryProviderModels.map(model => <option key={model.ref} value={model.ref}>
              {model.modelId}{hasConfirmedDecisionModelCapability(model) ? '' : ' · 能力待确认'}
            </option>)}
          </select>
          <small>{selected
            ? `System One/Jev 协议已识别 · ${selected.contextLimit ?? '未知'} 上下文`
            : '仅显示已声明 System One/Jev 决策协议的模型。普通 Chat 模型不能作为决策模型。'}</small>
        </label>
      </div>
      <div className="system-routing-fallbacks">
        <div className="settings-field">
          <span>备选模型（可选）</span>
          {fallbacks.length === 0 && <small>主模型不可用时按顺序尝试；不填写也可以保存。</small>}
          {fallbacks.map((model, index) => <div className="system-routing-fallback-row" key={model.ref}><span>{index + 1}. {providers[model.providerRef]?.displayName ?? model.providerRef} / {model.modelId}</span><button type="button" className="ghost-button" disabled={editingDisabled} onClick={() => onChange({ ...draft, fallbackModelRefs: draft.fallbackModelRefs.filter(ref => ref !== model.ref) })}>删除</button></div>)}
          <select className="text-input" value="" disabled={editingDisabled} onChange={event => {
            const ref = event.target.value;
            if (!ref || ref === draft.modelRef || draft.fallbackModelRefs.includes(ref)) return;
            onChange({ ...draft, fallbackModelRefs: [...draft.fallbackModelRefs, ref] });
          }}>
            <option value="">添加备选模型</option>
            {options.filter(model => model.ref !== draft.modelRef && !draft.fallbackModelRefs.includes(model.ref)).map(model => <option key={model.ref} value={model.ref}>
              {providers[model.providerRef]?.displayName ?? model.providerRef} / {model.modelId}
              {hasConfirmedDecisionModelCapability(model) ? '' : ' · 能力待确认'}
            </option>)}
          </select>
        </div>
      </div>
      <label className="settings-field">
        <span>决策超时（毫秒）</span>
        <input className="text-input" type="number" min={500} max={10_000} value={draft.timeoutMs} disabled={editingDisabled} onChange={event => onChange({ ...draft, timeoutMs: Number(event.target.value) })} />
        <small>{configured ? 'Provider 凭证状态由 Provider 卡片管理。' : `没有可用模型时，请先在 Provider 中添加或刷新模型。${credentialConfigured ? '旧版决策凭证仍已保存，可迁移到 Provider。' : ''}`}</small>
      </label>
    </section>
  );
}
