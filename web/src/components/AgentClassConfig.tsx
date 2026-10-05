import type { HttpClient } from '../api/http';
import { AgentCapabilityProfile } from './AgentCapabilityProfile';
import { AiActionStatus, type ResponsibilityRewriteFeedback } from './AiActionStatus';
import type {
  AgentClassRoutingDraft,
  AgentClassRoutingFacts,
  SettingsModelEntry,
  SettingsProviderEntry,
  RoutingObjective,
} from '../settings-model';
import {
  evaluateModelCompatibility,
  resolveProviderDisplayName,
} from '../settings-model';

interface AgentClassConfigProps {
  http?: HttpClient | null;
  facts: AgentClassRoutingFacts;
  draft: AgentClassRoutingDraft;
  models: SettingsModelEntry[];
  providers?: SettingsProviderEntry[];
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
  onSuggestResponsibility?: () => void;
  responsibilityFeedback?: ResponsibilityRewriteFeedback;
}

// 旧版本的“更新能力画像”“适合做什么”以及“某个模型为它带来的具体能力”
// 仍由兼容 API 提供，但设置页不再把它们作为用户输入；manualPreview?.tags
// 和 manualPreview?.capabilities 只保留给旧 revision 的读取兼容；“原文已保留”
// 仍可在旧 revision 的服务端结果中出现；当前定义仍可直接激活；旧版“当前可路由能力”
// 展示也由服务端兼容投影继续支持。
// 兼容旧 revision 状态文案：新增可路由能力、模型事实已变化，需要更新。
// 旧投影还可能包含：移除可路由能力、路由偏好变化、当前未满足。
// 能力证据和 manualPreview?.capabilityChanges 仍保持 API 兼容。
// “为什么这样路由”折叠说明已从界面移除，避免 Planner 卡片出现多余信息。

const objectiveOptions: Array<{ value: RoutingObjective; label: string }> = [
  { value: 'balanced', label: '均衡' },
  { value: 'quality', label: '质量优先' },
  { value: 'cost', label: '成本优先' },
  { value: 'latency', label: '速度优先' },
];

export function AgentClassConfig({
  http,
  facts,
  draft,
  models,
  providers = [],
  onChange,
  onSuggestResponsibility,
  responsibilityFeedback,
}: AgentClassConfigProps) {
  const responsibilitySuggestionLoading = responsibilityFeedback?.status === 'loading';
  const manuallyEdited = responsibilityFeedback?.after !== undefined
    && draft.responsibility !== responsibilityFeedback.after;
  const enabledModels = models.filter(model => model.enabled !== false);
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
    <article className="agent-route-card agent-editor-card">
      <header className="agent-editor-header">
        <div className="agent-editor-title">
          <span className="agent-editor-icon" aria-hidden="true">{facts.kind === 'planner' ? 'P' : 'A'}</span>
          <div>
            <div className="settings-eyebrow">智能体设置</div>
            <h3>{facts.kind === 'planner' ? '规划智能体' : '执行智能体'}</h3>
            <p>先定义职责，再选择模型；能力信息由系统根据模型事实自动补充。</p>
          </div>
        </div>
        <span className="system-badge">{facts.kind === 'planner' ? '系统智能体' : '可编辑'}</span>
      </header>

      <div className="agent-editor-basics">
        <label className="agent-name-field">
          <span>显示名称</span>
          <input
            className="text-input"
            value={draft.displayName ?? facts.displayName}
            maxLength={80}
            onChange={event => onChange({ ...draft, displayName: event.target.value })}
          />
        </label>
        {facts.kind === 'planner' ? (
          <section className="agent-fixed-responsibility">
            <div className="agent-form-heading">
              <div>
                <span className="field-label">职责</span>
                <small>系统固定，用于理解意图和编排任务。</small>
              </div>
              <span className="agent-field-badge">系统定义</span>
            </div>
            <strong>理解用户意图，拆解任务为 DAG 图，选择执行智能体并完成编排规划。</strong>
          </section>
        ) : (
          <section className="agent-responsibility-panel">
            <div className="agent-form-heading">
              <div>
                <span className="field-label">职责</span>
                <small>面向任务描述这个智能体负责什么，供智能路由匹配。</small>
              </div>
              {onSuggestResponsibility && (
                <button
                  type="button"
                  className="ghost-button agent-ai-button"
                  disabled={responsibilitySuggestionLoading}
                  onClick={onSuggestResponsibility}
                >
                  {responsibilitySuggestionLoading ? 'AI 改写中…' : 'AI 改写'}
                </button>
              )}
            </div>
            {responsibilityFeedback && <AiActionStatus
              feedback={responsibilityFeedback}
              title={responsibilitySuggestionLoading ? '正在 AI 改写'
                : responsibilityFeedback.status === 'error' ? '改写失败'
                  : responsibilityFeedback.status === 'stale' ? '本次建议未应用'
                    : manuallyEdited ? '已继续编辑'
                      : responsibilityFeedback.status === 'unchanged' ? '已检查，内容无变化' : 'AI 改写成功'}
              detail={responsibilitySuggestionLoading ? (draft.responsibility !== responsibilityFeedback.before
                ? '你已继续编辑，正在等待本次请求结束；新输入会保留。'
                : '正在优化职责。编辑框仍为改写前内容；继续编辑时，本次结果不会覆盖你的新输入。')
                : responsibilityFeedback.status === 'error' ? `${responsibilityFeedback.message} 当前内容未替换，可再次点击“AI 改写”。`
                  : responsibilityFeedback.status === 'stale' ? '请求期间职责或模型发生了变化，已保留当前内容，请重新改写。'
                    : manuallyEdited ? '当前为你继续调整后的职责；保存并激活后生效。'
                      : responsibilityFeedback.status === 'unchanged' ? '本次返回内容与原文一致，无需替换；编辑框保留原文。'
                        : '编辑框已填入改写后内容。可继续修改，保存并激活后生效。'}
            />}
            <textarea
              className="text-input agent-responsibility-input"
              aria-label="职责"
              rows={3}
              value={draft.responsibility}
              placeholder="例如：负责检索公共网络资料，核验来源并整理成带引用的结论。"
              onChange={event => onChange({
                ...draft,
                responsibility: event.target.value,
                executorManualSourceText: event.target.value,
              })}
            />
            {responsibilityFeedback?.after !== undefined && (
              <details className="ai-version-comparison">
                <summary>{responsibilityFeedback.status === 'stale' ? '查看本次建议（未应用）' : '查看改写前后'}</summary>
                <div className="ai-version-grid">
                  <div><strong>改写前</strong><p>{responsibilityFeedback.before || '未填写职责'}</p></div>
                  <div><strong>本次 AI 返回</strong><p>{responsibilityFeedback.after}</p></div>
                </div>
              </details>
            )}
            <div className="agent-responsibility-footer">
              <small>AI 改写会保留你的原意，并结合所选模型能力补充适用任务和边界。</small>
              <span>可继续编辑</span>
            </div>
          </section>
        )}
      </div>

      {renderRoutePolicyPanel({
        facts,
        draft,
        models,
        providers,
        enabledModels,
        modelCompatibility,
        selectedModel,
        effectiveMode,
        fixedModelAvailable,
        onChange,
      })}

      <div className="agent-route-facts">
        <AgentCapabilityProfile http={http} facts={facts} models={selectedModels} />
      </div>
    </article>
  );
}

function renderRoutePolicyPanel(input: {
  facts: AgentClassRoutingFacts;
  draft: AgentClassRoutingDraft;
  models: SettingsModelEntry[];
  providers: SettingsProviderEntry[];
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
    providers,
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
              aria-label={`${draft.displayName ?? facts.displayName} 路由模式`}
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
            系统先检查模型是否可用及是否满足执行条件。启用智能决策后，会结合职责、具体能力、
            任务要求和成本选择更合适的模型；决策服务不可用时按配置策略选择。
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
                        {resolveProviderDisplayName(
                          providers.find(provider => provider.providerRef === model.providerRef)?.providerRef
                            ?? model.providerRef,
                          providers.find(provider => provider.providerRef === model.providerRef)?.displayName,
                        )} · {
                          model.routingNotes?.summary || '可在模型服务中获取能力描述'
                        }
                      </small>
                      <small className={compatibility.eligible ? 'model-eligible' : 'model-rejected'}>
                        {compatibility.eligible
                          ? '可选用'
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
                  {model.modelId} · {resolveProviderDisplayName(
                    providers.find(provider => provider.providerRef === model.providerRef)?.providerRef
                      ?? model.providerRef,
                    providers.find(provider => provider.providerRef === model.providerRef)?.displayName,
                  )}
                  {compatibility.eligible ? '' : ` · 缺少 ${compatibility.missingCapabilities.join('/')}`}
                </option>
              );
            })}
          </select>
        </div>
      )}

    </div>
  );
}
