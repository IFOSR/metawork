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
  modelCapabilityLabel,
} from '../settings-model';

interface AgentClassConfigProps {
  facts: AgentClassRoutingFacts;
  draft: AgentClassRoutingDraft;
  models: SettingsModelEntry[];
  onChange: (draft: AgentClassRoutingDraft) => void;
  manualPreview?: {
    status: 'ready' | 'stale' | 'updating' | 'error';
    sourceText: string;
    persistedSourceText?: string;
    systemStale?: boolean;
    analysisMode?: 'semantic' | 'source-preserved';
    warning?: string;
    markdown?: string;
    tags?: {
      bestFit: string[];
      avoid: string[];
    };
    routableCapabilities?: string[];
    capabilities?: Array<{
      capabilityId: string;
      support: 'supported' | 'unsupported';
      routingDisposition: 'preferred' | 'allowed' | 'avoid' | 'disabled';
      evidence: Array<{
        kind: string;
        modelRef?: string;
        detail: string;
      }>;
      unresolvedReasons: string[];
    }>;
    capabilityChanges?: {
      added: string[];
      removed: string[];
      preferenceChanged: Array<{
        capabilityId: string;
        from: string;
        to: string;
      }>;
    };
    error?: string;
  };
  onUpdateManual?: () => void;
}

const objectiveOptions: Array<{ value: RoutingObjective; label: string }> = [
  { value: 'balanced', label: '均衡' },
  { value: 'quality', label: '质量优先' },
  { value: 'cost', label: '成本优先' },
  { value: 'latency', label: '速度优先' },
];

const capabilityLabels: Record<string, string> = {
  'current-web-research': '当前公共网络研究',
  'image-editing': '图片编辑',
  'image-generation': '图片生成',
  'workspace-engineering': '工作区工程',
};

const dispositionLabels = {
  preferred: '优先',
  allowed: '允许',
  avoid: '尽量避免',
  disabled: '已禁用',
} as const;

const evidenceLabels: Record<string, string> = {
  'model-system-known': '系统已知模型能力',
  'model-provider-declared': 'Provider 声明模型能力',
  'model-user-confirmed': '用户确认模型能力',
  'executor-affordance': 'Executor 执行支撑',
  'harness-support': 'Harness 执行协议',
  'executor-declaration': 'Executor 配置声明',
};

export function AgentClassConfig({
  facts,
  draft,
  models,
  onChange,
  manualPreview,
  onUpdateManual,
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

      {renderRoutePolicyPanel({
        facts,
        draft,
        models,
        enabledModels,
        modelCompatibility,
        selectedModel,
        effectiveMode,
        fixedModelAvailable,
        onChange,
      })}

      <div className="agent-route-facts">
        {facts.kind === 'executor' && (
          <section className="executor-guidance-section">
            <span className="fact-label">Executor 能力说明</span>
            <textarea
              className="text-input executor-guidance-input"
              value={draft.executorManualSourceText}
              maxLength={8_000}
              placeholder="用自然语言描述这个 Executor 擅长什么、不擅长什么，以及某个模型为它带来的具体能力。点击“更新能力画像”后，系统会统一解析并生成说明书。"
              onChange={event => onChange({
                ...draft,
                executorManualSourceText: event.target.value,
              })}
              rows={5}
            />
            <small className="field-help">
              这是该 Executor 独立的用户定义。模型事实与用户定义会共同编译能力画像，
              并更新 Planner 的实际路由资格；权限和模型白名单仍由受控配置管理。
            </small>
            <div className="executor-guidance-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={manualPreview?.status === 'updating'}
                onClick={onUpdateManual}
              >
                {manualPreview?.status === 'updating' ? '更新中…' : '更新能力画像'}
              </button>
              <span className={`manual-analysis-state manual-analysis-${manualPreview?.status ?? 'stale'}`}>
                {manualPreview?.status === 'ready' && manualPreview.systemStale
                  ? '模型事实已变化，需要更新'
                  : manualPreview?.status === 'ready'
                    && manualPreview.analysisMode === 'source-preserved'
                    ? '已更新，原文已保留'
                  : manualPreview?.status === 'ready' ? '能力画像已更新'
                  : manualPreview?.status === 'updating' ? '正在统一解析并生成'
                    : manualPreview?.status === 'error' ? '更新失败，需要重试'
                      : '能力画像需要更新'}
              </span>
            </div>
            {manualPreview?.status === 'ready' && manualPreview.systemStale && (
              <p className="field-help manual-system-stale">
                模型池、模型能力或模型路由说明已变化；点击“更新能力画像”会用最新模型事实重新解析并生成说明书。
              </p>
            )}
            {manualPreview?.error && (
              <p className="field-error">{manualPreview.error}</p>
            )}
            {manualPreview?.warning && (
              <p className="field-help manual-analysis-warning">
                语义解析暂不可用，已保留原文并完成系统能力编译；当前定义仍可直接激活，
                稍后可再次更新能力画像以补充结构化路由信息。
                （{manualPreview.warning}）
              </p>
            )}
            {manualPreview?.status === 'ready' && manualPreview.markdown && (
              <details className="executor-manual-preview" open>
                <summary>最终合并说明书预览</summary>
                <pre>{manualPreview.markdown}</pre>
              </details>
            )}
            {manualPreview?.status === 'ready' && (
              <section className="executor-capability-profile">
                <div className="capability-profile-heading">
                  <div>
                    <span className="fact-label">当前可路由能力</span>
                    <small className="field-help">
                      由当前模型、Executor 支撑条件和用户定义统一编译，只读展示。
                    </small>
                  </div>
                  <span className="system-badge">
                    {manualPreview?.routableCapabilities?.length ?? 0} 项
                  </span>
                </div>
                <div className="fact-list capability-route-list">
                  {manualPreview?.routableCapabilities?.map(capabilityId => {
                    const capability = manualPreview.capabilities?.find(
                      item => item.capabilityId === capabilityId,
                    );
                    return (
                      <span className="fact-chip fact-chip-positive" key={capabilityId}>
                        {capabilityLabels[capabilityId] ?? capabilityId}
                        {capability ? ` · ${dispositionLabels[capability.routingDisposition]}` : ''}
                      </span>
                    );
                  })}
                  {!manualPreview?.routableCapabilities?.length && (
                    <span className="fact-chip fact-chip-muted">当前没有可路由能力</span>
                  )}
                </div>

                {manualPreview?.capabilityChanges && (
                  <div className="capability-change-grid">
                    <div>
                      <span>新增可路由能力</span>
                      {manualPreview.capabilityChanges.added.map(capabilityId => (
                        <p key={capabilityId}>
                          + {capabilityLabels[capabilityId] ?? capabilityId}
                        </p>
                      ))}
                      {manualPreview.capabilityChanges.added.length === 0 && <p>无</p>}
                    </div>
                    <div>
                      <span>移除可路由能力</span>
                      {manualPreview.capabilityChanges.removed.map(capabilityId => (
                        <p key={capabilityId}>
                          - {capabilityLabels[capabilityId] ?? capabilityId}
                        </p>
                      ))}
                      {manualPreview.capabilityChanges.removed.length === 0 && <p>无</p>}
                    </div>
                    <div>
                      <span>路由偏好变化</span>
                      {manualPreview.capabilityChanges.preferenceChanged.map(change => (
                        <p key={change.capabilityId}>
                          {capabilityLabels[change.capabilityId] ?? change.capabilityId}
                          {`：${dispositionLabels[change.from as keyof typeof dispositionLabels] ?? change.from}`}
                          {' → '}
                          {dispositionLabels[change.to as keyof typeof dispositionLabels] ?? change.to}
                        </p>
                      ))}
                      {manualPreview.capabilityChanges.preferenceChanged.length === 0 && <p>无</p>}
                    </div>
                  </div>
                )}

                <div className="capability-detail-grid">
                  {manualPreview?.capabilities?.map(capability => (
                    <article
                      className="capability-detail-card"
                      data-supported={capability.support === 'supported'}
                      key={capability.capabilityId}
                    >
                      <div className="capability-detail-title">
                        <strong>
                          {capabilityLabels[capability.capabilityId] ?? capability.capabilityId}
                        </strong>
                        <span>
                          {capability.support === 'supported' ? '已支撑' : '当前未满足'}
                          {' · '}
                          {dispositionLabels[capability.routingDisposition]}
                        </span>
                      </div>
                      {capability.unresolvedReasons.length > 0 && (
                        <div className="capability-unresolved">
                          <span>当前未满足</span>
                          {capability.unresolvedReasons.map(reason => (
                            <p key={reason}>{reason}</p>
                          ))}
                        </div>
                      )}
                      <div className="capability-evidence">
                        <span>能力证据</span>
                        {capability.evidence.map((evidence, index) => (
                          <p key={`${evidence.kind}-${evidence.modelRef ?? ''}-${index}`}>
                            <strong>{evidenceLabels[evidence.kind] ?? evidence.kind}</strong>
                            {evidence.modelRef ? ` · ${evidence.modelRef}` : ''}
                            {`：${evidence.detail}`}
                          </p>
                        ))}
                        {capability.evidence.length === 0 && <p>暂无有效能力证据。</p>}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </section>
        )}
        {facts.kind === 'executor' ? (
          <section className="executor-capability-tags">
            <span className="fact-label">能力标签</span>
            <small className="field-help">
              标签由最终融合后的 Executor 能力说明书自动提炼，只读展示。
            </small>
            <div className="capability-tag-groups">
              <div>
                <span className="tag-group-label">适合</span>
                <div className="fact-list use-case-list">
                  {manualPreview?.tags?.bestFit.map(item => (
                    <span className="fact-chip fact-chip-positive" key={item}>{item}</span>
                  ))}
                  {!manualPreview?.tags?.bestFit.length && (
                    <span className="fact-chip fact-chip-muted">说明书解析后生成</span>
                  )}
                </div>
              </div>
              <div>
                <span className="tag-group-label">不适合</span>
                <div className="fact-list use-case-list">
                  {manualPreview?.tags?.avoid.map(item => (
                    <span className="fact-chip fact-chip-negative" key={item}>{item}</span>
                  ))}
                  {!manualPreview?.tags?.avoid.length && (
                    <span className="fact-chip fact-chip-muted">说明书解析后生成</span>
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section>
              <span className="fact-label">适合做什么</span>
              <div className="fact-list use-case-list">
                {draft.primaryUseCases.map(item => (
                  <span className="fact-chip fact-chip-positive" key={item}>{item}</span>
                ))}
                {draft.primaryUseCases.length === 0 && (
                  <span className="fact-chip fact-chip-muted">未配置</span>
                )}
              </div>
            </section>
            <section>
              <span className="fact-label">不适合做什么</span>
              <div className="fact-list use-case-list">
                {draft.avoidUseCases.map(item => (
                  <span className="fact-chip fact-chip-negative" key={item}>{item}</span>
                ))}
                {draft.avoidUseCases.length === 0 && (
                  <span className="fact-chip fact-chip-muted">未配置</span>
                )}
              </div>
            </section>
          </>
        )}
        {facts.kind === 'planner' && (
          <section>
            <span className="fact-label">系统配置能力</span>
            <div className="fact-list">
              {[...facts.routingCapabilities, ...facts.affordances].map(item => (
                <span className="fact-chip" key={item}>{item}</span>
              ))}
            </div>
            {facts.capabilityContracts.map(contract => (
              <p className="fact-contract" key={contract}>{contract}</p>
            ))}
          </section>
        )}
      </div>

    </article>
  );
}

function renderRoutePolicyPanel(input: {
  facts: AgentClassRoutingFacts;
  draft: AgentClassRoutingDraft;
  models: SettingsModelEntry[];
  enabledModels: SettingsModelEntry[];
  modelCompatibility: Map<string, ReturnType<typeof evaluateModelCompatibility>>;
  selectedModel: SettingsModelEntry | undefined;
  effectiveMode: AgentClassRoutingDraft['mode'];
  fixedModelAvailable: boolean;
  onChange: (draft: AgentClassRoutingDraft) => void;
}) {
  const {
    facts,
    draft,
    models,
    enabledModels,
    modelCompatibility,
    selectedModel,
    effectiveMode,
    fixedModelAvailable,
    onChange,
  } = input;

  return (
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
                          fallbackModelRefs: (draft.fallbackModelRefs ?? [])
                            .filter(ref => nextAllowed.includes(ref)),
                          defaultModelRef: nextDefault,
                        });
                      }}
                    />
                    <span>
                      <strong>{model.modelId}</strong>
                      <small>
                        {humanizeProviderRef(model.providerRef)} · {
                          model.capabilities.map(modelCapabilityLabel).join(' / ') || '能力未确认'
                        }
                      </small>
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
  );
}
