import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type {
  ActivateResult,
  ConfigSnapshot,
  ConfigurationCompletionResult,
  ConfigurationRuntimeState,
} from '../api/types';
import { resolveProviderSecretReference } from './provider-secret-state';
import {
  AgentClassConfig,
} from './AgentClassConfig';
import {
  buildProviderModelOptions,
  invalidRoutingDrafts,
  humanizeAgentClassRef,
  humanizeProviderRef,
  MODEL_CAPABILITY_IDS,
  MODEL_CAPABILITY_LABELS,
  refsForModelIdentity,
  removeModelRefsFromRoutingDraft,
  ROUTING_CAPABILITY_CONTRACTS,
  type AgentClassRoutingFacts,
  type ConfigurationFieldState,
  type SettingsModelEntry,
  type SettingsProviderEntry,
  type RoutingDraftMap,
} from '../settings-model';

interface SettingsPanelProps {
  http: HttpClient | null;
  runtime: ConfigurationRuntimeState | null;
  onClose: () => void;
}

type ProviderDraft = SettingsProviderEntry & { apiKey: string };
type ModelDraft = SettingsModelEntry;
type CatalogDraft = {
  providers: Record<string, ProviderDraft>;
  models: Record<string, ModelDraft>;
};
type RoutingDraft = RoutingDraftMap;
type RoutingFacts = Record<string, AgentClassRoutingFacts>;
type RuntimePolicyDraft = {
  maxConcurrentTasks: number;
};

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === 'object' ? value as RawRecord : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function normalizeProviderUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

function loadCatalog(config: RawRecord, completion?: ConfigurationCompletionResult): CatalogDraft {
  const rawProviders = asRecord(config.providers);
  const rawModels = asRecord(config.models);
  const completionProviders = completion?.providers ?? {};
  const providers = Object.fromEntries(Object.entries(rawProviders).map(([providerRef, raw]) => {
    const provider = asRecord(raw);
    const completed = completionProviders[providerRef];
    const baseUrl = String(provider.baseUrl ?? completed?.baseUrl ?? '');
    const preset = completion?.providerPresets.find(candidate => (
      candidate.providerRef === providerRef || candidate.baseUrl === baseUrl
    ));
    return [
      providerRef,
      {
        providerRef,
        displayName: completed?.displayName
          ?? preset?.displayName
          ?? humanizeProviderRef(providerRef),
        baseUrl,
        modelIds: [...new Set([
          ...(completed?.modelIds ?? []),
          ...(preset?.modelIds ?? []),
        ])],
        apiKey: '',
        credentialState: completed?.credentialState ?? '需要确认',
        enabled: provider.enabled !== false,
      },
    ];
  }));
  const configuredUrls = new Set(
    Object.values(providers).map(provider => normalizeProviderUrl(provider.baseUrl)),
  );
  for (const [providerRef, completed] of Object.entries(completionProviders)) {
    const baseUrl = completed.baseUrl ?? '';
    const normalizedUrl = normalizeProviderUrl(baseUrl);
    if (
      providers[providerRef]
      || completed.credentialState === '缺失'
      || (normalizedUrl && configuredUrls.has(normalizedUrl))
    ) {
      continue;
    }
    providers[providerRef] = {
      providerRef,
      displayName: completed.displayName,
      baseUrl,
      modelIds: completed.modelIds,
      apiKey: '',
      credentialState: completed.credentialState,
      enabled: true,
    };
    if (normalizedUrl) configuredUrls.add(normalizedUrl);
  }
  const models = Object.fromEntries(Object.entries(rawModels).map(([ref, raw]) => {
    const model = asRecord(raw);
    const rawCapabilities = stringList(model.capabilities);
    const completedModel = completion?.models?.[ref];
    const capabilities = rawCapabilities.length > 0
      ? rawCapabilities
      : stringList(completedModel?.capabilities);
    return [
      ref,
      {
        ref,
        providerRef: String(model.providerRef ?? ''),
        modelId: String(model.modelId ?? ref),
        capabilities,
        capabilityState: capabilities.length > 0 ? '已自动发现' : '需要确认',
        ...(typeof model.contextLimit === 'number' ? { contextLimit: model.contextLimit } : {}),
        ...(typeof model.costInputPerMillion === 'number'
          ? { costInputPerMillion: model.costInputPerMillion }
          : {}),
        ...(typeof model.costOutputPerMillion === 'number'
          ? { costOutputPerMillion: model.costOutputPerMillion }
          : {}),
        ...(typeof model.latencyTier === 'string' ? { latencyTier: model.latencyTier } : {}),
        ...(typeof model.qualityTier === 'string' ? { qualityTier: model.qualityTier } : {}),
        ...(typeof model.reasoning === 'string' ? { reasoning: model.reasoning } : {}),
        ...(typeof model.costTier === 'string' ? { costTier: model.costTier } : {}),
        enabled: model.enabled !== false,
      },
    ];
  }));
  return { providers, models };
}

function loadRuntimePolicy(config: RawRecord): RuntimePolicyDraft {
  const policy = asRecord(config.runtimePolicy);
  return {
    maxConcurrentTasks: typeof policy.maxConcurrentTasks === 'number' ? policy.maxConcurrentTasks : 2,
  };
}

function loadRoutingDraft(config: RawRecord): RoutingDraft {
  const rawAgentClasses = asRecord(config.agentClasses);
  const modelRefs = Object.keys(asRecord(config.models));
  return Object.fromEntries(Object.entries(rawAgentClasses).map(([agentClassRef, raw]) => {
    const agentClass = asRecord(raw);
    const policy = asRecord(agentClass.modelPolicy);
    const isPlanner = agentClass.kind === 'planner' || agentClassRef === 'planner';
    const mode = isPlanner || policy.mode !== 'auto' ? 'fixed' : 'auto';
    const allowedModelRefs = mode === 'auto'
      ? stringList(policy.allowedModelRefs).filter(ref => modelRefs.includes(ref))
      : [];
    const modelRef = typeof policy.modelRef === 'string'
      ? policy.modelRef
      : typeof policy.defaultModelRef === 'string'
        ? policy.defaultModelRef
        : modelRefs[0] ?? '';
    const fallback = asRecord(policy.objective);
    return [
      agentClassRef,
      {
        mode,
        modelRef,
        allowedModelRefs: allowedModelRefs.length > 0
          ? allowedModelRefs
          : modelRef ? [modelRef] : modelRefs.slice(0, 1),
        defaultModelRef: typeof policy.defaultModelRef === 'string'
          ? policy.defaultModelRef
          : allowedModelRefs[0] ?? modelRefs[0] ?? '',
        objective: fallback.priority === 'quality'
          || fallback.priority === 'cost'
          || fallback.priority === 'latency'
          ? fallback.priority
          : 'balanced',
        minimumQualityTier: fallback.minimumQualityTier === 'high'
          || fallback.minimumQualityTier === 'medium'
          ? fallback.minimumQualityTier
          : 'low',
        primaryUseCases: stringList(agentClass.primaryUseCases),
        avoidUseCases: stringList(agentClass.avoidUseCases),
      },
    ];
  }));
}

function loadRoutingFacts(config: RawRecord): RoutingFacts {
  const rawAgentClasses = asRecord(config.agentClasses);
  const rawHarnesses = asRecord(config.harnesses);
  return Object.fromEntries(Object.entries(rawAgentClasses).map(([agentClassRef, raw]) => {
    const agentClass = asRecord(raw);
    const harnessRef = String(agentClass.harnessRef ?? '');
    const harness = asRecord(rawHarnesses[harnessRef]);
    const baseFacts = {
      kind: agentClass.kind === 'planner' ? 'planner' as const : 'executor' as const,
      driverId: String(harness.driverId ?? '未声明'),
    };
    const primaryUseCases = stringList(agentClass.primaryUseCases);
    const avoidUseCases = stringList(agentClass.avoidUseCases);
    return [
      agentClassRef,
      {
        agentClassRef,
        displayName: humanizeAgentClassRef(agentClassRef),
        kind: baseFacts.kind,
        harnessRef,
        harnessLabel: humanizeProviderRef(harnessRef),
        transport: String(harness.transport ?? '未声明'),
        driverId: baseFacts.driverId,
        primaryUseCases,
        avoidUseCases,
        routingCapabilities: stringList(agentClass.routingCapabilities),
        capabilityContracts: stringList(agentClass.routingCapabilities)
          .map(capability => ROUTING_CAPABILITY_CONTRACTS[capability])
          .filter((contract): contract is string => Boolean(contract)),
        affordances: stringList(agentClass.plannerAffordances),
      },
    ];
  }));
}

function fieldStateLabel(state: ConfigurationFieldState): string {
  return state;
}

export function SettingsPanel({ http, runtime, onClose }: SettingsPanelProps) {
  const [activationState, setActivationState] = useState<ConfigurationRuntimeState | null>(runtime);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [facts, setFacts] = useState<RoutingFacts | null>(null);
  const [catalog, setCatalog] = useState<CatalogDraft | null>(null);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicyDraft | null>(null);
  const [newModelIds, setNewModelIds] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ActivateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const secretStatusVersion = useRef(0);

  const applyConfigSnapshot = (
    snapshot: ConfigSnapshot,
    completion?: ConfigurationCompletionResult,
  ) => {
    const config = snapshot.config as RawRecord;
    setRevisionId(snapshot.revisionId);
    setCatalog(loadCatalog(config, completion));
    setRuntimePolicy(loadRuntimePolicy(config));
    setDraft(loadRoutingDraft(config));
    setFacts(loadRoutingFacts(config));
  };

  useEffect(() => {
    setActivationState(runtime);
  }, [runtime]);

  useEffect(() => {
    if (!http) return;
    let cancelled = false;
    const refresh = () => {
      void http.getActivationStatus().then(state => {
        if (!cancelled) setActivationState(state);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [http]);

  useEffect(() => {
    if (!http || !catalog) return;
    const providerRefs = Object.keys(catalog.providers);
    if (providerRefs.length === 0) return;
    let cancelled = false;
    const requestVersion = ++secretStatusVersion.current;
    void http.getSecretStatus(providerRefs).then(existence => {
      if (cancelled || requestVersion !== secretStatusVersion.current) return;
      setCatalog(current => current
        ? {
          ...current,
          providers: Object.fromEntries(Object.entries(current.providers).map(([ref, provider]) => [
            ref,
            {
              ...provider,
              credentialState: provider.apiKey
                ? provider.credentialState
                : existence[ref] ? '已自动发现' : provider.credentialState,
            },
          ])),
        }
        : current);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [http, catalog ? Object.keys(catalog.providers).join(',') : '']);

  useEffect(() => {
    if (!http) return;
    void refreshConfigurationCompletion().catch(error => setLoadError((error as Error).message));
  }, [http]);

  const refreshConfigurationCompletion = async () => {
    if (!http) return;
    const [snapshot, completion] = await Promise.all([
      http.getConfig(),
      http.getConfigurationCompletion(),
    ]);
    const existence = await http.getSecretStatus(Object.keys(completion.providers))
      .catch(() => ({} as Record<string, boolean>));
    applyConfigSnapshot(snapshot, {
      ...completion,
      providers: Object.fromEntries(
        Object.entries(completion.providers).map(([providerRef, provider]) => [
          providerRef,
          existence[providerRef]
            ? { ...provider, credentialState: '已自动发现' as const }
            : provider,
        ]),
      ),
    });
  };

  const draftValidationIssues = draft && catalog
    ? invalidRoutingDrafts(draft, Object.values(catalog.models))
    : [];
  const editingDisabled = loading || activationState?.activationAllowed === false;

  const activate = async () => {
    if (!http || !revisionId || !draft || !catalog || !runtimePolicy || activationState?.activationAllowed === false) return;
    const missingCredentials = Object.values(catalog.providers)
      .filter(provider => provider.credentialState === '缺失' && !provider.apiKey)
      .map(provider => provider.providerRef);
    if (draftValidationIssues.length > 0) {
      setResult(null);
      setLoadError(`以下路由配置需要重新选择可用模型：${draftValidationIssues.join('、')}`);
      return;
    }
    if (missingCredentials.length > 0) {
      setResult(null);
      setLoadError(`以下 Provider 缺少凭据：${missingCredentials.join('、')}`);
      return;
    }
    setLoadError(null);
    setLoading(true);
    setResult(null);
    try {
      const original = await http.getConfig();
      const originalConfig = original.config as RawRecord;
      const originalProviders = asRecord(originalConfig.providers);
      const originalAgentClasses = asRecord(originalConfig.agentClasses);
      const knownSecretReferences = Object.values(originalProviders)
        .map(provider => asRecord(provider).apiKeyRef)
        .filter((reference): reference is string => typeof reference === 'string');
      const activationSecrets: Record<string, string> = {};
      const providers: Record<string, RawRecord> = {};
      const models: Record<string, RawRecord> = {};
      const agentClasses: Record<string, RawRecord> = {};

      for (const provider of Object.values(catalog.providers)) {
        if (provider.apiKey.trim()) activationSecrets[provider.providerRef] = provider.apiKey.trim();
        const originalProvider = asRecord(originalProviders[provider.providerRef]);
        providers[provider.providerRef] = {
          ...originalProvider,
          protocol: originalProvider.protocol ?? 'openai-compatible',
          baseUrl: provider.baseUrl,
          apiKeyRef: resolveProviderSecretReference(
            provider.providerRef,
            provider.baseUrl,
            Object.fromEntries(Object.entries(originalProviders).map(([ref, value]) => [ref, {
              baseUrl: asRecord(value).baseUrl as string | undefined,
              apiKeyRef: asRecord(value).apiKeyRef as string | undefined,
            }])),
            {},
            knownSecretReferences,
          ),
          region: originalProvider.region ?? 'international',
          enabled: provider.enabled !== false,
        };
      }

      for (const model of Object.values(catalog.models)) {
        const originalModel = asRecord(asRecord(originalConfig.models)[model.ref]);
        const sameIdentity = originalModel.providerRef === model.providerRef
          && originalModel.modelId === model.modelId;
        models[model.ref] = {
          ...(sameIdentity ? originalModel : {}),
          modelId: model.modelId,
          providerRef: model.providerRef,
          capabilities: model.capabilities,
          ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
          ...(model.costInputPerMillion !== undefined
            ? { costInputPerMillion: model.costInputPerMillion }
            : {}),
          ...(model.costOutputPerMillion !== undefined
            ? { costOutputPerMillion: model.costOutputPerMillion }
            : {}),
          ...(model.latencyTier ? { latencyTier: model.latencyTier } : {}),
          ...(model.qualityTier ? { qualityTier: model.qualityTier } : {}),
          ...(model.costTier ? { costTier: model.costTier } : {}),
          reasoning: model.reasoning ?? (sameIdentity ? originalModel.reasoning : undefined) ?? 'high',
          enabled: model.enabled !== false,
        };
      }

      for (const [ref, entry] of Object.entries(draft)) {
        const current = asRecord(originalAgentClasses[ref]);
        agentClasses[ref] = {
          ...current,
          primaryUseCases: entry.primaryUseCases ?? [],
          avoidUseCases: entry.avoidUseCases ?? [],
          modelPolicy: entry.mode === 'auto'
            ? {
              mode: 'auto',
              allowedModelRefs: entry.allowedModelRefs,
              defaultModelRef: entry.defaultModelRef || undefined,
              fallback: { enabled: false, order: [] },
              objective: {
                priority: entry.objective,
                minimumQualityTier: entry.minimumQualityTier,
              },
            }
            : { mode: 'fixed', modelRef: entry.modelRef },
        };
      }

      const response = await http.activate(revisionId, {
        ...originalConfig,
        providers,
        models,
        agentClasses,
        runtimePolicy: {
          ...asRecord(originalConfig.runtimePolicy),
          ...runtimePolicy,
        },
      }, activationSecrets);
      setResult(response);
      const revisionMismatch = response.issues?.some(issue => /revision mismatch|revision has changed/iu.test(issue));
      if (!response.ok && (
        response.code === 'revision_conflict'
        || (response.code === 'activation_failed' && revisionMismatch)
      )) {
        try {
          const latest = await http.getConfig();
          applyConfigSnapshot(latest);
          setLoadError(response.code === 'revision_conflict'
            ? '配置已在其他窗口或进程中更新，已重新加载最新配置。请检查后再次激活。'
            : '激活时发现运行时配置版本已变化，已回滚并重新加载当前配置。请检查后再次激活。');
        } catch (reloadError) {
          setLoadError(`激活使用的配置已失效，且最新配置加载失败：${(reloadError as Error).message}`);
        }
      }
      if (response.ok && response.revisionId) {
        secretStatusVersion.current += 1;
        setRevisionId(response.revisionId);
        await refreshConfigurationCompletion();
      }
    } catch (error) {
      setResult({ ok: false, code: 'network', issues: [(error as Error).message] });
    } finally {
      setLoading(false);
    }
  };

  const addProvider = () => {
    setCatalog(current => {
      if (!current) return current;
      let index = Object.keys(current.providers).length + 1;
      let providerRef = `custom-provider-${index}`;
      while (current.providers[providerRef]) {
        index += 1;
        providerRef = `custom-provider-${index}`;
      }
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerRef]: {
            providerRef,
            displayName: '自定义 Provider',
            baseUrl: '',
            modelIds: [],
            apiKey: '',
            credentialState: '缺失',
          },
        },
      };
    });
  };

  const removeProvider = (providerRef: string) => {
    if (editingDisabled || !catalog) return;
    const modelRefs = Object.values(catalog.models)
      .filter(model => model.providerRef === providerRef)
      .map(model => model.ref);
    setCatalog(current => {
      if (!current) return current;
      const providers = { ...current.providers };
      delete providers[providerRef];
      const models = Object.fromEntries(
        Object.entries(current.models).filter(([, model]) => model.providerRef !== providerRef),
      );
      return { providers, models };
    });
    setDraft(current => current ? removeModelRefsFromRoutingDraft(current, modelRefs) : current);
  };

  const removeProviderModel = (providerRef: string, modelId: string) => {
    if (editingDisabled || !catalog) return;
    const modelRefs = refsForModelIdentity(
      Object.values(catalog.models),
      providerRef,
      modelId,
    );
    setCatalog(current => current
      ? {
        ...current,
        models: Object.fromEntries(
          Object.entries(current.models).filter(([, model]) => !modelRefs.includes(model.ref)),
        ),
      }
      : current);
    setDraft(current => current ? removeModelRefsFromRoutingDraft(current, modelRefs) : current);
  };

  const addKnownModel = (providerRef: string, modelId: string) => {
    setCatalog(current => {
      if (!current || Object.values(current.models).some(model => (
        model.providerRef === providerRef && model.modelId === modelId
      ))) return current;
      let index = Object.keys(current.models).length + 1;
      let ref = `${providerRef}-${index}`;
      while (current.models[ref]) {
        index += 1;
        ref = `${providerRef}-${index}`;
      }
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            capabilities: [],
            capabilityState: '需要确认',
          },
        },
      };
    });
  };

  const toggleModelCapability = (modelRef: string, capability: string) => {
    if (editingDisabled) return;
    setCatalog(current => {
      if (!current) return current;
      const model = current.models[modelRef];
      if (!model) return current;
      const enabled = model.capabilities.includes(capability);
      const capabilities = enabled
        ? model.capabilities.filter(item => item !== capability)
        : [...model.capabilities, capability].sort();
      return {
        ...current,
        models: {
          ...current.models,
          [modelRef]: {
            ...model,
            capabilities,
            capabilityState: capabilities.length > 0 ? '已自动发现' : '需要确认',
          },
        },
      };
    });
  };

  const addCustomModel = (providerRef: string) => {
    const modelId = (newModelIds[providerRef] ?? '').trim();
    if (!modelId) {
      setLoadError('请输入要加入 Provider 模型目录的 Model ID。');
      return;
    }
    setCatalog(current => {
      if (!current) return current;
      if (Object.values(current.models).some(model => (
        model.providerRef === providerRef && model.modelId === modelId
      ))) return current;
      let index = Object.keys(current.models).length + 1;
      let ref = `custom-model-${index}`;
      while (current.models[ref]) {
        index += 1;
        ref = `custom-model-${index}`;
      }
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            capabilities: [],
            capabilityState: '需要确认',
          },
        },
      };
    });
    setNewModelIds(current => ({ ...current, [providerRef]: '' }));
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer settings-workbench" onClick={event => event.stopPropagation()}>
        <header className="drawer-header settings-header">
          <div>
            <div className="settings-eyebrow">CONFIGURATION WORKBENCH</div>
            <h2>设置</h2>
            <p>配置 Provider 模型目录，以及 Planner、Codex、Pi 的路由偏好。</p>
          </div>
          <div className="settings-header-actions">
            <span className={`activation-pill activation-pill-${activationState?.activationStatus ?? 'idle'}`}>
              {activationState?.activationStatus === 'busy' ? '运行中，暂不可激活'
                : activationState?.activationStatus === 'activating' ? '正在激活'
                  : '可热激活'}
            </span>
            <button className="ghost-button" onClick={onClose}>关闭</button>
          </div>
        </header>

        <div className="drawer-body settings-body">
          {activationState && !activationState.activationAllowed && (
            <div className="result-banner result-error">
              当前不能激活：{activationState.blockingReasons?.map(reason => reason.message).join('；') || '运行时正在处理任务'}
            </div>
          )}
          {loadError && <div className="result-banner result-error">加载失败：{loadError}</div>}
          {!draft && !loadError && <div className="empty-hint">加载配置中…</div>}

          {draft && catalog && facts && runtimePolicy && (
            <div className="settings-sections">
              <section className="settings-section runtime-policy-section">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">00 / RUNTIME CAPACITY</div>
                    <h3>并行与队列</h3>
                    <p>不同会话可并行执行；同一会话的后续 Task 会排队。</p>
                  </div>
                </div>
                <div className="runtime-policy-grid">
                  <label className="settings-field">
                    <span>同时运行任务数</span>
                    <input className="text-input" type="number" min={1} max={8}
                      value={runtimePolicy.maxConcurrentTasks}
                      onChange={event => setRuntimePolicy(current => current ? {
                        ...current, maxConcurrentTasks: Number(event.target.value),
                      } : current)} />
                    <small>最多可同时运行多少个会话任务；同一会话内仍按顺序执行。</small>
                  </label>
                </div>
                <div className="routing-section-note">
                  降低上限不会取消当前运行中的 Task，只影响下一轮调度；配置激活仍遵守现有 revision 和运行中安全门。
                </div>
              </section>
              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">01 / PROVIDER CATALOG</div>
                    <h3>Provider</h3>
                    <p>Provider 内加入的模型才会进入 Planner 和 Executor 的候选集。</p>
                  </div>
                  <button className="ghost-button" onClick={addProvider}>新增 Provider</button>
                </div>
                <div className="provider-grid">
                  {Object.values(catalog.providers).map(provider => {
                    const knownModels = buildProviderModelOptions(
                      Object.values(catalog.providers),
                      Object.values(catalog.models),
                      provider.providerRef,
                    );
                    return (
                      <article className="provider-card" key={provider.providerRef}>
                        <div className="provider-card-heading">
                          <div>
                            <h4>{provider.displayName}</h4>
                            <span className="mono">{provider.baseUrl || '尚未填写 Base URL'}</span>
                          </div>
                          <div className="provider-card-actions">
                            <span className={`state-badge ${provider.credentialState === '缺失' ? 'state-badge-warning' : ''}`}>
                              {fieldStateLabel(provider.credentialState)}
                            </span>
                            <button
                              className="text-button danger-button"
                              disabled={editingDisabled}
                              onClick={() => removeProvider(provider.providerRef)}
                            >
                              删除 Provider
                            </button>
                          </div>
                        </div>
                        <div className="provider-stat">
                          <strong>{knownModels.length}</strong>
                          <span>个已知模型</span>
                        </div>
                        <label className="settings-field">
                          <span>Base URL</span>
                          <input
                            className="text-input"
                            value={provider.baseUrl}
                            onChange={event => setCatalog(current => current ? {
                              ...current,
                              providers: {
                                ...current.providers,
                                [provider.providerRef]: { ...provider, baseUrl: event.target.value },
                              },
                            } : current)}
                          />
                        </label>
                        {provider.credentialState === '缺失' ? (
                          <label className="settings-field">
                            <span>API Key</span>
                            <input
                              className="text-input"
                              type="password"
                              value={provider.apiKey}
                              placeholder="仅在缺少凭据时填写"
                              onChange={event => setCatalog(current => current ? {
                                ...current,
                                providers: {
                                  ...current.providers,
                                  [provider.providerRef]: { ...provider, apiKey: event.target.value },
                                },
                              } : current)}
                              autoComplete="off"
                            />
                          </label>
                        ) : (
                          <div className="credential-summary">
                            凭据已由 SecretStore / 本机配置提供，不重复展示 API Key。
                          </div>
                        )}
                        {knownModels.length > 0 && (
                          <div className="provider-model-list">
                            <span className="fact-label">Provider 模型目录</span>
                            {knownModels.map(option => (
                              <div className="provider-model-line" key={option.modelId}>
                                <span>{option.modelId}</span>
                                {option.configured ? (
                                  <button
                                    className="text-button danger-button"
                                    disabled={editingDisabled}
                                    onClick={() => removeProviderModel(provider.providerRef, option.modelId)}
                                  >
                                    移除
                                  </button>
                                ) : (
                                  <button
                                    className="text-button"
                                    disabled={editingDisabled}
                                    onClick={() => addKnownModel(provider.providerRef, option.modelId)}
                                  >
                                    加入候选
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {provider.modelIds.length === 0 && (
                          <div className="provider-custom-model">
                            <input
                              className="text-input"
                              value={newModelIds[provider.providerRef] ?? ''}
                              placeholder="输入自定义 Model ID"
                              onChange={event => setNewModelIds(current => ({
                                ...current,
                                [provider.providerRef]: event.target.value,
                              }))}
                              disabled={editingDisabled}
                            />
                            <button
                              className="ghost-button"
                              disabled={editingDisabled}
                              onClick={() => addCustomModel(provider.providerRef)}
                            >
                              加入候选
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">02 / MODEL CAPABILITIES</div>
                    <h3>模型能力</h3>
                    <p>为每个模型声明能力，用于路由能力基线筛选；勾选后保存并激活生效。</p>
                  </div>
                </div>
                <div className="model-catalog">
                  {Object.values(catalog.models).map(model => (
                    <article className="model-card" key={model.ref}>
                      <div className="model-card-heading">
                        <div>
                          <strong>{model.modelId}</strong>
                          <span className="mono">{humanizeProviderRef(model.providerRef)}</span>
                        </div>
                        <span className={`state-badge ${model.capabilityState === '需要确认' ? 'state-badge-warning' : ''}`}>
                          {fieldStateLabel(model.capabilityState)}
                        </span>
                      </div>
                      <div className="capability-toggles">
                        {MODEL_CAPABILITY_IDS.map(capability => (
                          <label className="capability-toggle" key={capability}>
                            <input
                              type="checkbox"
                              checked={model.capabilities.includes(capability)}
                              disabled={editingDisabled}
                              onChange={() => toggleModelCapability(model.ref, capability)}
                            />
                            <span>{capability}</span>
                            <small>{MODEL_CAPABILITY_LABELS[capability]}</small>
                          </label>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">03 / AGENTCLASS ROUTING</div>
                    <h3>路由策略</h3>
                    <p>Planner 只能手动选择一个模型；Codex 和 Pi 可以使用 Fixed 或 Auto。</p>
                  </div>
                </div>
                <p className="routing-section-note">Auto 只在当前 AgentClass 支持且用户勾选的候选模型中进行运行时选择。</p>
                <div className="routing-stack">
                  {Object.entries(draft).map(([ref, entry]) => {
                    const agentFacts = facts[ref];
                    if (!agentFacts) return null;
                    return (
                      <AgentClassConfig
                        key={ref}
                        facts={agentFacts}
                        draft={entry}
                        models={Object.values(catalog.models)}
                        onChange={next => setDraft(current => current ? { ...current, [ref]: next } : current)}
                      />
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {result && (
            <div className={`result-banner ${result.ok ? 'result-ok' : 'result-error'}`}>
              {result.ok
                ? result.restartRequired
                  ? `配置包含进程级变更，需要重启后生效：${result.restartPaths?.join('、') ?? ''}`
                  : '配置已热激活。新任务和下一轮 Planner 将使用新配置。'
                : result.code === 'restart_required'
                  ? `此更改需要重启服务后生效：${result.restartPaths?.join('、') ?? '进程级配置变更'}`
                  : `激活失败（${result.code ?? 'unknown'}）`}
              {result.issues && result.issues.length > 0 && (
                <ul className="issues">
                  {result.issues.map((issue, index) => <li key={index}>{issue}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>

        {(draft || loadError) && (
          <footer className="drawer-footer">
            <button className="ghost-button" onClick={onClose}>取消</button>
            <button
              className="primary-button"
              onClick={activate}
              disabled={
                loading
                || activationState?.activationAllowed === false
                || draftValidationIssues.length > 0
              }
            >
              {loading || activationState?.activationStatus === 'activating' ? '激活中…' : '保存并激活'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
