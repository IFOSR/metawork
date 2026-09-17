import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type {
  ActivateResult,
  AgentReadiness,
  ConfigSnapshot,
  ConfigurationCompletionResult,
  ConfigurationRuntimeState,
  ExecutorCapabilityManual,
  ExecutorManualAnalysis,
  ProviderCredentialStatus,
} from '../api/types';
import {
  maskApiKey,
  resolveProviderSecretReferenceFromConfiguration,
} from './provider-secret-state';
import { buildPlannerScopedConfiguration, keepActivePlanner } from '../planner-update';
import { ModelConnectionDialog, type NewModelConnectionDraft } from './ModelConnectionDialog';
import {
  AgentClassConfig,
} from './AgentClassConfig';
import {
  buildProviderModelOptions,
  invalidRoutingDrafts,
  humanizeProviderRef,
  refsForModelIdentity,
  removeModelRefsFromRoutingDraft,
  ROUTING_CAPABILITY_CONTRACTS,
  executorManualInputKey,
  evaluateModelCompatibility,
  MODEL_CAPABILITY_IDS,
  MODEL_CAPABILITY_LABELS,
  resolveAgentDisplayName,
  resolveProviderDisplayName,
  type AgentClassRoutingFacts,
  type ModelCapabilityId,
  type SettingsModelEntry,
  type SettingsProviderEntry,
  type RoutingDraftMap,
} from '../settings-model';

interface SettingsPanelProps {
  http: HttpClient | null;
  runtime: ConfigurationRuntimeState | null;
  onClose: () => void;
  agentReadiness?: AgentReadiness[];
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
type ManualCapabilityChanges = {
  added: string[];
  removed: string[];
  preferenceChanged: Array<{
    capabilityId: string;
    from: string;
    to: string;
  }>;
};
type ManualPreviewState = {
  status: 'ready' | 'stale' | 'updating' | 'error';
  sourceText: string;
  inputKey?: string;
  persistedSourceText?: string;
  systemStale?: boolean;
  analysisMode?: ExecutorManualAnalysis['analysisMode'];
  warning?: string;
  markdown?: string;
  tags?: ExecutorCapabilityManual['tags'];
  routableCapabilities?: ExecutorCapabilityManual['routableCapabilities'];
  capabilities?: ExecutorCapabilityManual['capabilities'];
  capabilityChanges?: ManualCapabilityChanges;
  assertionsSourceFingerprint?: string;
  semanticReceipt?: string;
  assertions?: ExecutorManualAnalysis['userProfile']['assertions'];
  error?: string;
};

function asRecord(value: unknown): RawRecord {
  return value && typeof value === 'object' ? value as RawRecord : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compareManualCapabilities(
  previous: ManualPreviewState | undefined,
  next: ExecutorCapabilityManual,
): ManualCapabilityChanges | undefined {
  if (!previous?.capabilities || !previous.routableCapabilities) return undefined;
  const previousRoutable = new Set(previous.routableCapabilities);
  const nextRoutable = new Set(next.routableCapabilities);
  const previousById = new Map(previous.capabilities.map(capability => [
    capability.capabilityId,
    capability,
  ]));
  return {
    added: next.routableCapabilities.filter(capability => !previousRoutable.has(capability)),
    removed: previous.routableCapabilities.filter(capability => !nextRoutable.has(capability)),
    preferenceChanged: next.capabilities.flatMap(capability => {
      const prior = previousById.get(capability.capabilityId);
      return prior && prior.routingDisposition !== capability.routingDisposition
        ? [{
            capabilityId: capability.capabilityId,
            from: prior.routingDisposition,
            to: capability.routingDisposition,
          }]
        : [];
    }),
  };
}

function hasRoutingNotes(
  notes: SettingsModelEntry['routingNotes'] | undefined,
): boolean {
  return Boolean(
    notes?.summary?.trim()
    || notes?.strengths?.length
    || notes?.limitations?.length
    || notes?.preferredTaskTypes?.length
    || notes?.avoidTaskTypes?.length,
  );
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
        displayName: typeof provider.displayName === 'string' && provider.displayName.trim()
          ? provider.displayName.trim()
          : completed?.displayName
          ?? preset?.displayName
          ?? resolveProviderDisplayName(providerRef),
        baseUrl,
        modelIds: [...new Set([
          ...(completed?.modelIds ?? []),
          ...(preset?.modelIds ?? []),
        ])],
        apiKey: '',
        maskedApiKey: completed?.maskedApiKey ?? null,
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
      maskedApiKey: completed.maskedApiKey ?? null,
      credentialState: completed.credentialState,
      enabled: true,
    };
    if (normalizedUrl) configuredUrls.add(normalizedUrl);
  }
  const models = Object.fromEntries(Object.entries(rawModels).map(([ref, raw]) => {
    const model = asRecord(raw);
    const rawCapabilities = stringList(model.capabilities);
    const completedModel = completion?.models?.[ref];
    const capabilities = [...new Set([
      ...rawCapabilities,
      ...stringList(completedModel?.capabilities),
    ])].sort();
    const rawNotes = asRecord(model.routingNotes);
    const routingNotes = {
      summary: optionalString(rawNotes.summary),
      strengths: stringList(rawNotes.strengths),
      limitations: stringList(rawNotes.limitations),
      preferredTaskTypes: stringList(rawNotes.preferredTaskTypes),
      avoidTaskTypes: stringList(rawNotes.avoidTaskTypes),
    };
    return [
      ref,
      {
        ref,
        providerRef: String(model.providerRef ?? ''),
        modelId: String(model.modelId ?? ref),
        capabilities,
        capabilityState: completedModel?.capabilityState
          ?? (capabilities.length > 0 ? '已自动发现' : '需要确认'),
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
        routingNotes,
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
         displayName: resolveAgentDisplayName(
           agentClassRef,
           typeof agentClass.displayName === 'string' ? agentClass.displayName : undefined,
         ),
         mode,
        modelRef,
        allowedModelRefs: allowedModelRefs.length > 0
          ? allowedModelRefs
          : modelRef ? [modelRef] : modelRefs.slice(0, 1),
        defaultModelRef: typeof policy.defaultModelRef === 'string'
          ? policy.defaultModelRef
          : allowedModelRefs[0] ?? modelRefs[0] ?? '',
        fallbackModelRefs: stringList(asRecord(policy.fallback).order)
          .filter(ref => modelRefs.includes(ref)),
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
        executorManualSourceText: typeof asRecord(agentClass.executorManual).sourceText === 'string'
          ? String(asRecord(agentClass.executorManual).sourceText)
          : '',
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
        displayName: resolveAgentDisplayName(
          agentClassRef,
          typeof agentClass.displayName === 'string' ? agentClass.displayName : undefined,
        ),
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

export function SettingsPanel({
  http,
  runtime,
  onClose,
  agentReadiness = [],
}: SettingsPanelProps) {
  const [activationState, setActivationState] = useState<ConfigurationRuntimeState | null>(runtime);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [facts, setFacts] = useState<RoutingFacts | null>(null);
  const [catalog, setCatalog] = useState<CatalogDraft | null>(null);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicyDraft | null>(null);
  const [newModelIds, setNewModelIds] = useState<Record<string, string>>({});
  const [capabilityCatalog, setCapabilityCatalog] = useState<Record<string, string[]>>({});
  const [modelDiscoveries, setModelDiscoveries] = useState<Record<string, {
    status: 'loading' | 'ready' | 'error';
    modelIds?: string[];
    capabilities?: Record<string, string[]>;
    message?: string;
  }>>({});
  const [capabilityEditorRef, setCapabilityEditorRef] = useState<string | null>(null);
  const [result, setResult] = useState<ActivateResult | null>(null);
  const [plannerResult, setPlannerResult] = useState<ActivateResult | null>(null);
  const [plannerUpdating, setPlannerUpdating] = useState(false);
  const [activeRoutingDraft, setActiveRoutingDraft] = useState<RoutingDraft | null>(null);
  const [manualPreviews, setManualPreviews] = useState<Record<string, ManualPreviewState>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const secretStatusVersion = useRef(0);

  const applyConfigSnapshot = (
    snapshot: ConfigSnapshot,
    completion?: ConfigurationCompletionResult,
  ) => {
    const config = snapshot.config as RawRecord;
    setRevisionId(snapshot.revisionId);
    setCatalog(loadCatalog(config, completion));
    setRuntimePolicy(loadRuntimePolicy(config));
    const nextDraft = loadRoutingDraft(config);
    setActiveRoutingDraft(nextDraft);
    setDraft(nextDraft);
    setFacts(loadRoutingFacts(config));
    setManualPreviews({});
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
    if (!http || !facts || !revisionId) return;
    const executorRefs = Object.entries(facts)
      .filter(([, entry]) => entry.kind === 'executor')
      .map(([ref]) => ref);
    if (executorRefs.length === 0) return;
    let cancelled = false;
    void Promise.all(executorRefs.map(async ref => {
      try {
        const manual: ExecutorCapabilityManual = await http.getExecutorCapabilityManual(ref, revisionId);
        return [ref, {
          status: 'ready' as const,
          sourceText: draft?.[ref]?.executorManualSourceText ?? '',
          persistedSourceText: draft?.[ref]?.executorManualSourceText.trim() ?? '',
          inputKey: draft?.[ref]
            ? executorManualInputKey(draft[ref], Object.values(catalog?.models ?? {}))
            : undefined,
          markdown: manual.markdown,
          tags: manual.tags,
          routableCapabilities: manual.routableCapabilities,
          capabilities: manual.capabilities,
        }] as const;
      } catch (error) {
        return [ref, {
          status: 'error' as const,
          sourceText: draft?.[ref]?.executorManualSourceText ?? '',
          error: (error as Error).message,
        }] as const;
      }
    })).then(entries => {
      if (!cancelled) setManualPreviews(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [http, revisionId, facts, draft ? Object.keys(draft).join(',') : '']);

  useEffect(() => {
    if (!draft || !catalog || !facts) return;
    setManualPreviews(current => {
      let changed = false;
      const next = { ...current };
      for (const [ref, entry] of Object.entries(draft)) {
        if (facts[ref]?.kind !== 'executor') continue;
        const preview = current[ref];
        if (!preview?.inputKey) continue;
        const systemStale = preview.inputKey
          !== executorManualInputKey(entry, Object.values(catalog.models));
        if (preview.systemStale === systemStale) continue;
        next[ref] = { ...preview, systemStale };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [catalog, draft, facts]);

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
              maskedApiKey: existence[ref]?.maskedApiKey ?? provider.maskedApiKey ?? null,
              credentialState: provider.apiKey
                ? provider.credentialState
                : existence[ref]?.configured ? '已自动发现' : provider.credentialState,
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
    setCapabilityCatalog(completion.modelCapabilityCatalog ?? {});
    const existence = await http.getSecretStatus(Object.keys(completion.providers))
      .catch((): Record<string, ProviderCredentialStatus> => ({}));
    const configuredByUrl = new Map<string, {
      configured: boolean;
      maskedApiKey: string | null;
    }>();
    for (const [providerRef, provider] of Object.entries(completion.providers)) {
      const status = existence[providerRef];
      if (!status?.configured || !provider.baseUrl) continue;
      configuredByUrl.set(normalizeProviderUrl(provider.baseUrl), {
        configured: true,
        maskedApiKey: status.maskedApiKey,
      });
    }
    applyConfigSnapshot(snapshot, {
      ...completion,
      providers: Object.fromEntries(
        Object.entries(completion.providers).map(([providerRef, provider]) => [
          providerRef,
          existence[providerRef]?.configured
            ? {
              ...provider,
              maskedApiKey: existence[providerRef]?.maskedApiKey ?? null,
              credentialState: '已自动发现' as const,
            }
            : configuredByUrl.get(normalizeProviderUrl(provider.baseUrl ?? ''))?.configured
              ? {
                ...provider,
                maskedApiKey: configuredByUrl.get(normalizeProviderUrl(provider.baseUrl ?? ''))!.maskedApiKey,
                credentialState: '已自动发现' as const,
              }
            : provider,
        ]),
      ),
    });
  };

  const draftValidationIssues = draft && catalog
    ? invalidRoutingDrafts(draft, Object.values(catalog.models))
    : [];

  // 保存前预检：按 AgentClass 的硬性能力要求检查已绑定模型，避免激活时
  // 才拿到 "no eligible model candidate" 这种无法定位的错误。
  const routingPrecheckWarnings = (() => {
    if (!draft || !catalog || !facts) return [] as string[];
    const warnings: string[] = [];
    for (const [agentClassRef, entry] of Object.entries(draft)) {
      const agentFacts = facts[agentClassRef];
      if (!agentFacts) continue;
      // Planner 在第一步单独预检，不在此重复。
      if (agentClassRef === 'planner') continue;
      const modelRefs = entry.mode === 'fixed'
        ? [entry.modelRef]
        : [...new Set([entry.defaultModelRef, ...entry.allowedModelRefs])];
      for (const modelRef of modelRefs) {
        if (!modelRef) continue;
        const model = catalog.models[modelRef];
        if (!model) continue;
        const compatibility = evaluateModelCompatibility(model, agentFacts);
        if (compatibility.eligible) continue;
        warnings.push(
          `${agentFacts.displayName}：${model.modelId} 缺少 ${compatibility.missingCapabilities.join(' / ')}`
          + '，激活或任务调度会被拒绝（可在上方模型卡片中补充该模型的能力标签）',
        );
      }
    }
    return [...new Set(warnings)];
  })();
  const editingDisabled = loading || activationState?.activationAllowed === false;

  const buildCandidateConfiguration = (originalConfig: RawRecord): {
    config: Record<string, unknown>;
    activationSecrets: Record<string, string>;
  } => {
    if (!draft || !catalog || !runtimePolicy) {
      throw new Error('配置草稿尚未加载完成');
    }
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
        displayName: provider.displayName.trim(),
        baseUrl: provider.baseUrl.trim(),
        apiKeyRef: resolveProviderSecretReferenceFromConfiguration(
          provider.providerRef,
          provider.baseUrl,
          originalProviders,
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
        routingNotes: hasRoutingNotes(model.routingNotes) ? model.routingNotes : undefined,
        reasoning: model.reasoning ?? (sameIdentity ? originalModel.reasoning : undefined) ?? 'high',
        enabled: model.enabled !== false,
      };
    }

    for (const [ref, entry] of Object.entries(draft)) {
      const current = asRecord(originalAgentClasses[ref]);
      const preview = manualPreviews[ref];
      const currentManual = asRecord(current.executorManual);
      const manualSourceText = entry.executorManualSourceText.trim();
      const currentSourceText = typeof currentManual.sourceText === 'string'
        ? currentManual.sourceText.trim()
        : '';
      const normalizedAssertions = preview?.status === 'ready'
        && preview.sourceText.trim() === manualSourceText
        ? preview.assertions ?? (
          Array.isArray(currentManual.assertions) ? currentManual.assertions : []
        )
        : currentSourceText === manualSourceText && Array.isArray(currentManual.assertions)
          ? currentManual.assertions
          : [];
      const assertionsSourceFingerprint = preview?.status === 'ready'
        && preview.analysisMode === 'semantic'
        && preview.sourceText.trim() === manualSourceText
        ? preview.assertionsSourceFingerprint
        : currentSourceText === manualSourceText
          ? optionalString(currentManual.assertionsSourceFingerprint)
          : undefined;
      const semanticReceipt = preview?.status === 'ready'
        && preview.analysisMode === 'semantic'
        && preview.sourceText.trim() === manualSourceText
        ? preview.semanticReceipt
        : currentSourceText === manualSourceText
          ? optionalString(currentManual.semanticReceipt)
          : undefined;
      agentClasses[ref] = {
        ...current,
        displayName: (entry.displayName ?? '').trim(),
        primaryUseCases: entry.primaryUseCases ?? [],
        avoidUseCases: entry.avoidUseCases ?? [],
        ...(manualSourceText || current.executorManual
          ? {
              executorManual: {
                ...currentManual,
                sourceText: manualSourceText,
                assertionsSourceFingerprint,
                semanticReceipt,
                assertions: normalizedAssertions,
              },
            }
          : {}),
        modelPolicy: entry.mode === 'auto'
          ? {
            mode: 'auto',
            allowedModelRefs: entry.allowedModelRefs,
            defaultModelRef: entry.defaultModelRef || undefined,
            fallback: {
              enabled: (entry.fallbackModelRefs?.length ?? 0) > 0,
              order: entry.fallbackModelRefs ?? [],
            },
            objective: {
              priority: entry.objective,
              minimumQualityTier: entry.minimumQualityTier,
            },
          }
          : { mode: 'fixed', modelRef: entry.modelRef },
      };
    }

    return {
      config: {
        ...originalConfig,
        providers,
        models,
        agentClasses,
        runtimePolicy: {
          ...asRecord(originalConfig.runtimePolicy),
          ...runtimePolicy,
        },
      },
      activationSecrets,
    };
  };

  // Planner 更新只提交「Planner 绑定 + 它依赖的 Model/Provider」，其余参数
  // 保持运行中配置不变（见 web/src/planner-update.ts）。
  const buildPlannerCandidateConfiguration = (originalConfig: RawRecord): {
    config: Record<string, unknown>;
    activationSecrets: Record<string, string>;
  } => {
    if (!draft) throw new Error('配置草稿尚未加载完成');
    const full = buildCandidateConfiguration(originalConfig);
    return buildPlannerScopedConfiguration({
      activeConfig: originalConfig,
      candidateConfig: full.config,
      candidateSecrets: full.activationSecrets,
    });
  };

  const plannerDraft = draft?.planner;
  const plannerDirty = Boolean(
    plannerDraft && activeRoutingDraft?.planner
    && JSON.stringify(plannerDraft) !== JSON.stringify(activeRoutingDraft.planner),
  );
  const plannerBlocked = activationState?.activationAllowed === false;
  const plannerPrecheckWarnings = (() => {
    if (!plannerDraft || !catalog || !facts?.planner) return [] as string[];
    const modelRef = plannerDraft.mode === 'fixed'
      ? plannerDraft.modelRef
      : plannerDraft.defaultModelRef;
    if (!modelRef) return ['Planner 尚未选择模型'];
    const model = catalog.models[modelRef];
    if (!model) {
      return [`规划设置绑定的模型 ${modelRef} 不在模型目录中，请重新选择`];
    }
    const compatibility = evaluateModelCompatibility(model, facts.planner);
    if (compatibility.eligible) return [] as string[];
    return [
      `规划设置绑定 ${model.modelId} 缺少 ${compatibility.missingCapabilities.join(' / ')}`
      + '，更新会被拒绝（可在模型卡片中补充该模型的能力标签）',
    ];
  })();

  const updatePlanner = async (): Promise<void> => {
    if (!http || !revisionId || !draft || !catalog || plannerBlocked) return;
    setLoadError(null);
    setPlannerResult(null);
    setPlannerUpdating(true);
    try {
      const original = await http.getConfig();
      const candidate = buildPlannerCandidateConfiguration(original.config as RawRecord);
      const response = await http.activate(
        revisionId,
        candidate.config,
        candidate.activationSecrets,
      );
      setPlannerResult(response);
      if (response.ok && response.revisionId) {
        secretStatusVersion.current += 1;
        setRevisionId(response.revisionId);
        // 只同步 Planner 基线，保留其它板块的未保存编辑。
        try {
          const latest = await http.getConfig();
          const reloaded = loadRoutingDraft(latest.config as RawRecord);
          setActiveRoutingDraft(current => (
            current ? { ...current, planner: reloaded.planner } : reloaded
          ));
        } catch {
          // 基线同步失败不影响已完成的更新结果。
        }
        await http.getConfigurationCompletion()
          .then(completion => setCapabilityCatalog(completion.modelCapabilityCatalog ?? {}))
          .catch(() => undefined);
      }
    } catch (error) {
      setPlannerResult({ ok: false, code: 'network', issues: [(error as Error).message] });
    } finally {
      setPlannerUpdating(false);
    }
  };

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
      setLoadError(`以下模型连接缺少 API Key：${missingCredentials.join('、')}`);
      return;
    }
    setLoadError(null);
    setLoading(true);
    setResult(null);
    try {
      const original = await http.getConfig();
      const full = buildCandidateConfiguration(original.config as RawRecord);
      const candidate = {
        // 常规保存不修改 Planner：用运行中的 Planner 覆盖，而不是删除它。
        config: keepActivePlanner({
          activeConfig: original.config as RawRecord,
          candidateConfig: full.config,
        }),
        activationSecrets: full.activationSecrets,
      };
      const response = await http.activate(
        revisionId,
        candidate.config,
        candidate.activationSecrets,
      );
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

  const updateManual = async (agentClassRef: string) => {
    if (!http || !revisionId || !draft || !catalog || !runtimePolicy) return;
    const sourceText = draft[agentClassRef]?.executorManualSourceText.trim() ?? '';
    const previousPreview = manualPreviews[agentClassRef];
    setManualPreviews(current => ({
      ...current,
      [agentClassRef]: {
        ...current[agentClassRef],
        status: 'updating',
        sourceText,
      },
    }));
    try {
      const original = await http.getConfig();
      const candidate = buildCandidateConfiguration(original.config as RawRecord);
      const analysis = await http.compileExecutorCapabilityManual(
        agentClassRef,
        revisionId,
        sourceText,
        candidate.config,
      );
      setManualPreviews(current => ({
        ...current,
        [agentClassRef]: {
          status: 'ready',
          sourceText: analysis.sourceText,
          persistedSourceText: previousPreview?.persistedSourceText ?? '',
          inputKey: executorManualInputKey(
            draft[agentClassRef],
            Object.values(catalog?.models ?? {}),
          ),
          systemStale: false,
          analysisMode: analysis.analysisMode,
          warning: analysis.warning,
          markdown: analysis.manual.markdown,
          tags: analysis.manual.tags,
          routableCapabilities: analysis.manual.routableCapabilities,
          capabilities: analysis.manual.capabilities,
          capabilityChanges: compareManualCapabilities(previousPreview, analysis.manual),
          assertionsSourceFingerprint: analysis.userProfile.assertionsSourceFingerprint,
          semanticReceipt: analysis.userProfile.semanticReceipt,
          assertions: analysis.userProfile.assertions,
        },
      }));
      setLoadError(null);
    } catch (error) {
      setManualPreviews(current => ({
        ...current,
        [agentClassRef]: {
          ...current[agentClassRef],
          status: 'error',
          sourceText,
          error: (error as Error).message,
        },
      }));
    }
  };

  const createModelConnection = (connection: NewModelConnectionDraft) => {
    let index = Object.keys(catalog?.providers ?? {}).length + 1;
    let providerRef = `custom-model-${index}`;
    while (catalog?.providers[providerRef]) {
      index += 1;
      providerRef = `custom-model-${index}`;
    }
    const provider: ProviderDraft = {
      providerRef,
      displayName: connection.displayName,
      baseUrl: connection.baseUrl,
      modelIds: [],
      apiKey: connection.apiKey,
      maskedApiKey: maskApiKey(connection.apiKey),
      credentialState: '已自动发现',
      enabled: true,
    };
    setCatalog(current => {
      if (!current) return current;
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerRef]: provider,
        },
      };
    });
    setModelDialogOpen(false);
    void discoverModels(provider);
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

  const capabilitiesForModelId = (modelId: string): string[] => (
    [...new Set(capabilityCatalog[modelId] ?? [])].sort()
  );

  const addKnownModel = (
    providerRef: string,
    modelId: string,
    discoveredCapabilities?: string[],
  ) => {
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
      const capabilities = [...new Set([
        ...(discoveredCapabilities ?? []),
        ...capabilitiesForModelId(modelId),
      ])].sort();
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            capabilities,
            capabilityState: capabilities.length > 0 ? '已从 Provider 补全' : '需要确认',
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
      const capabilities = capabilitiesForModelId(modelId);
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            capabilities,
            capabilityState: capabilities.length > 0 ? '已从 Provider 补全' : '需要确认',
          },
        },
      };
    });
    setNewModelIds(current => ({ ...current, [providerRef]: '' }));
  };

  const discoverModels = async (provider: ProviderDraft): Promise<void> => {
    if (!http) return;
    setModelDiscoveries(current => ({
      ...current,
      [provider.providerRef]: { status: 'loading' },
    }));
    try {
      const result = await http.discoverProviderModels({
        baseUrl: provider.baseUrl,
        ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
        providerRef: provider.providerRef,
      });
      if (result.status !== 'discovered') {
        setModelDiscoveries(current => ({
          ...current,
          [provider.providerRef]: {
            status: 'error',
          message: '未能获取模型列表：请检查 API URL 与 API Key，或确认该模型服务提供 OpenAI 兼容的 /models 接口。',
          },
        }));
        return;
      }
      setModelDiscoveries(current => ({
        ...current,
        [provider.providerRef]: {
          status: 'ready',
          modelIds: result.modelIds,
          capabilities: result.capabilities,
        },
      }));
      setCatalog(current => {
        if (!current) return current;
        const entry = current.providers[provider.providerRef];
        if (!entry) return current;
        return {
          ...current,
          providers: {
            ...current.providers,
            [provider.providerRef]: {
              ...entry,
              modelIds: [...new Set([...entry.modelIds, ...result.modelIds])]
                .sort((left, right) => left.localeCompare(right)),
            },
          },
        };
      });
    } catch (error) {
      setModelDiscoveries(current => ({
        ...current,
        [provider.providerRef]: { status: 'error', message: (error as Error).message },
      }));
    }
  };

  const updateModelCapabilities = (modelRef: string, capabilities: string[]): void => {
    setCatalog(current => {
      if (!current) return current;
      const model = current.models[modelRef];
      if (!model) return current;
      const next = [...new Set(capabilities)].sort();
      return {
        ...current,
        models: {
          ...current.models,
          [modelRef]: {
            ...model,
            capabilities: next,
            capabilityState: next.length > 0 ? '已从 Provider 补全' : '需要确认',
          },
        },
      };
    });
  };

  const toggleModelCapability = (modelRef: string, capabilityId: ModelCapabilityId): void => {
    const model = catalog?.models[modelRef];
    if (!model) return;
    updateModelCapabilities(
      modelRef,
      model.capabilities.includes(capabilityId)
        ? model.capabilities.filter(capability => capability !== capabilityId)
        : [...model.capabilities, capabilityId],
    );
  };

  const plannerSection = (
    <section className="settings-section planner-section">
      <div className="section-heading">
        <div>
          <div className="settings-eyebrow">PLANNING</div>
          <h3>规划设置</h3>
          <p>
            规划使用的模型来自模型列表。修改后单独更新，其他设置的保存不会覆盖它。
          </p>
        </div>
        <span className={`state-badge ${plannerDirty ? 'state-badge-warning' : ''}`}>
          {plannerDirty ? '有未更新的修改' : '与运行中一致'}
        </span>
      </div>

      {facts?.planner && plannerDraft && catalog && (
        <AgentClassConfig
          facts={facts.planner}
          draft={plannerDraft}
          models={Object.values(catalog.models)}
          providers={Object.values(catalog.providers)}
          onChange={next => {
            setDraft(current => (current ? { ...current, planner: next } : current));
          }}
        />
      )}

      {plannerPrecheckWarnings.length > 0 && (
        <div className="result-banner result-error">
          <ul className="issues">
            {plannerPrecheckWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="planner-update-row">
        <button
          className="primary-button"
          onClick={() => { void updatePlanner(); }}
          disabled={plannerUpdating
            || plannerBlocked
            || !plannerDirty
            || plannerPrecheckWarnings.length > 0}
        >
          {plannerUpdating ? '更新规划设置中…' : '更新规划设置'}
        </button>
        <span className="planner-update-hint">
          {plannerBlocked
            ? `当前不能更新：${activationState?.blockingReasons?.map(reason => reason.message).join('；')
              || '运行时正在处理任务'}`
            : plannerPrecheckWarnings.length > 0
              ? '请先解决上方的问题'
              : !plannerDirty
                ? '没有待更新的规划设置修改'
                : '仅提交规划设置及它依赖的模型连接'}
        </span>
      </div>

      {plannerResult && (
        <div className={`result-banner ${plannerResult.ok ? 'result-ok' : 'result-error'}`}>
          {plannerResult.ok
            ? '规划设置已更新。'
            : `更新失败（${plannerResult.code ?? 'unknown'}）`}
          {plannerResult.issues && plannerResult.issues.length > 0 && (
            <ul className="issues">
              {plannerResult.issues.map((issue, index) => <li key={index}>{issue}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer settings-workbench" onClick={event => event.stopPropagation()}>
        <header className="drawer-header settings-header">
          <div>
            <div className="settings-eyebrow">CONFIGURATION WORKBENCH</div>
            <h2>设置</h2>
            <p>管理模型连接、智能体路由和运行策略。模型连接只需要名称、API URL 和 API Key。</p>
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

              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">01 / MODEL CONNECTIONS</div>
                    <h3 id="models-heading">模型列表</h3>
                    <p>每个模型连接可以独立命名、更新 API Key，并提供给智能体进行路由。</p>
                  </div>
                  <button
                    className="primary-button"
                    disabled={editingDisabled}
                    onClick={() => setModelDialogOpen(true)}
                  >
                    新增模型
                  </button>
                </div>
                <div className="provider-grid">
                  {Object.values(catalog.providers).map(provider => {
                    const knownModels = buildProviderModelOptions(
                      Object.values(catalog.providers),
                      Object.values(catalog.models),
                      provider.providerRef,
                    );
                    return (
                      <article className="provider-card model-connection-card" key={provider.providerRef}>
                        <div className="provider-card-heading">
                          <div>
                            <h4>{provider.displayName || '未命名模型'}</h4>
                            <span className="mono">{provider.baseUrl || '尚未填写 API URL'}</span>
                          </div>
                          <div className="provider-card-actions">
                            <span className={`state-badge ${
                              !provider.apiKey.trim() && !provider.maskedApiKey
                                ? 'state-badge-warning'
                                : ''
                            }`}>
                              {provider.apiKey.trim()
                                ? `已配置 · ${maskApiKey(provider.apiKey.trim())}`
                                : provider.maskedApiKey
                                  ? `已配置 · ${provider.maskedApiKey}`
                                  : '未配置'}
                            </span>
                            <button
                              className="text-button danger-button"
                              disabled={editingDisabled}
                              onClick={() => removeProvider(provider.providerRef)}
                            >
                              删除模型
                            </button>
                          </div>
                        </div>
                        <div className="provider-stat">
                          <strong>{knownModels.length}</strong>
                          <span>个可用模型</span>
                        </div>
                        <label className="settings-field">
                          <span>名称</span>
                          <input
                            className="text-input"
                            value={provider.displayName}
                            onChange={event => setCatalog(current => current ? {
                              ...current,
                              providers: {
                                ...current.providers,
                                [provider.providerRef]: {
                                  ...provider,
                                  displayName: event.target.value,
                                },
                              },
                            } : current)}
                            disabled={editingDisabled}
                          />
                        </label>
                        <label className="settings-field">
                          <span>API URL</span>
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
                            disabled={editingDisabled}
                          />
                        </label>
                        <label className="settings-field">
                          <span>更新 API Key</span>
                          <input
                            className="text-input"
                            type="password"
                            value={provider.apiKey}
                            placeholder="留空保持不变"
                            onChange={event => setCatalog(current => current ? {
                              ...current,
                              providers: {
                                ...current.providers,
                                [provider.providerRef]: {
                                  ...provider,
                                  apiKey: event.target.value,
                                },
                              },
                            } : current)}
                            autoComplete="new-password"
                            disabled={editingDisabled}
                          />
                          <small>页面只显示掩码；输入新的 Key 后保存即可替换。</small>
                        </label>
                        <div className="provider-discovery">
                          <button
                            className="ghost-button"
                            disabled={editingDisabled
                              || !provider.baseUrl.trim()
                              || modelDiscoveries[provider.providerRef]?.status === 'loading'}
                            onClick={() => { void discoverModels(provider); }}
                          >
                            {modelDiscoveries[provider.providerRef]?.status === 'loading'
                              ? '正在获取模型列表…'
                              : '重新发现模型'}
                          </button>
                          {modelDiscoveries[provider.providerRef]?.status === 'error' && (
                            <p className="provider-discovery-message provider-discovery-error">
                              {modelDiscoveries[provider.providerRef]?.message}
                            </p>
                          )}
                          {modelDiscoveries[provider.providerRef]?.status === 'ready' && (
                            <div className="provider-discovery-list">
                                <span className="fact-label">
                                发现 {modelDiscoveries[provider.providerRef]?.modelIds?.length ?? 0} 个模型（未收录的模型可以手工加入）
                              </span>
                              {(modelDiscoveries[provider.providerRef]?.modelIds ?? []).map(modelId => {
                                const configured = Object.values(catalog.models).some(model => (
                                  model.providerRef === provider.providerRef && model.modelId === modelId
                                ));
                                const discoveredCapabilities =
                                  modelDiscoveries[provider.providerRef]?.capabilities?.[modelId] ?? [];
                                const capabilities = [...new Set([
                                  ...discoveredCapabilities,
                                  ...capabilitiesForModelId(modelId),
                                ])];
                                return (
                                  <div className="provider-model-line" key={modelId}>
                                    <span>{modelId}</span>
                                    <span className="capability-badges">
                                      {capabilities.length > 0
                                        ? capabilities.join(' / ')
                                        : '能力待确认'}
                                    </span>
                                    {configured ? (
                                      <span className="fact-label">已加入</span>
                                    ) : (
                                      <button
                                        className="text-button"
                                        disabled={editingDisabled}
                                        onClick={() => addKnownModel(
                                          provider.providerRef,
                                          modelId,
                                          discoveredCapabilities,
                                        )}
                                      >
                                        加入候选
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        {knownModels.length > 0 && (
                          <div className="provider-model-list">
                            <span className="fact-label">模型目录</span>
                            {knownModels.map(option => (
                              <div key={option.modelId}>
                                <div className="provider-model-line">
                                  <span>{option.modelId}</span>
                                  {option.configured && option.modelRef && (
                                    <span className="capability-badges">
                                      {catalog.models[option.modelRef]?.capabilities.length
                                        ? catalog.models[option.modelRef]!.capabilities.join(' / ')
                                        : '能力待确认'}
                                    </span>
                                  )}
                                  {option.configured && option.modelRef && (
                                    <button
                                      className="text-button"
                                      disabled={editingDisabled}
                                      onClick={() => setCapabilityEditorRef(current => (
                                        current === option.modelRef ? null : option.modelRef
                                      ))}
                                    >
                                      {catalog.models[option.modelRef]?.capabilities.length
                                        ? '调整能力'
                                        : '补充能力'}
                                    </button>
                                  )}
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
                                {option.configured
                                  && option.modelRef
                                  && capabilityEditorRef === option.modelRef && (
                                  <div className="capability-editor">
                                    <span className="fact-label">
                                      能力标签（库内已收录的模型会自动预填，可手工补充/修正）
                                    </span>
                                    <div className="capability-checkboxes">
                                      {MODEL_CAPABILITY_IDS.map(capabilityId => (
                                        <label className="capability-checkbox" key={capabilityId}>
                                          <input
                                            type="checkbox"
                                            disabled={editingDisabled}
                                            checked={catalog.models[option.modelRef!]
                                              ?.capabilities.includes(capabilityId) ?? false}
                                            onChange={() => toggleModelCapability(
                                              option.modelRef!,
                                              capabilityId,
                                            )}
                                          />
                                          <span>{MODEL_CAPABILITY_LABELS[capabilityId]}</span>
                                        </label>
                                      ))}
                                    </div>
                                    <div className="capability-editor-actions">
                                      <button
                                        className="text-button"
                                        disabled={editingDisabled
                                          || capabilitiesForModelId(option.modelId).length === 0}
                                        onClick={() => updateModelCapabilities(
                                          option.modelRef!,
                                          capabilitiesForModelId(option.modelId),
                                        )}
                                      >
                                        使用目录推荐
                                      </button>
                                      <button
                                        className="text-button danger-button"
                                        disabled={editingDisabled}
                                        onClick={() => setCapabilityEditorRef(null)}
                                      >
                                        收起
                                      </button>
                                    </div>
                                  </div>
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

              <section className="settings-section agents-section" aria-labelledby="agents-heading">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">02 / AGENTS</div>
                    <h3 id="agents-heading">智能体</h3>
                    <p>每个智能体可以单独选择模型、路由方式和能力配置。</p>
                  </div>
                </div>
                {agentReadiness.length > 0 && (
                  <div className="agent-readiness-settings">
                    {agentReadiness.filter(agent => agent.agentId === 'pi-agent').map(agent => (
                      <div className={`agent-readiness-settings-card agent-readiness-settings-${agent.status}`} key={agent.agentId}>
                        <div>
                          <strong>{agent.status === 'installed' ? '智能体 1 已就绪' : '智能体 1 未就绪'}</strong>
                          <p>
                            {agent.status === 'installed'
                              ? 'MetaWork 可以开始新工作。'
                              : '这是运行新工作的必需组件，请先安装后再开始任务。'}
                          </p>
                        </div>
                        {agent.status !== 'installed' && (
                          <div className="agent-readiness-actions">
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => window.open(agent.installUrl, '_blank', 'noopener,noreferrer')}
                            >
                              打开安装页面
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {agentReadiness.filter(agent => agent.agentId === 'codex-cli').map(agent => (
                      <div className="agent-readiness-settings-card agent-readiness-settings-optional" key={agent.agentId}>
                        <div>
                          <strong>智能体 2 {agent.status === 'installed' ? '已安装' : '可选增强'}</strong>
                          <p>
                            {agent.status === 'installed'
                              ? '已提供额外的 GPT/Codex 路由与回退选择。'
                              : '安装后对 GPT/Codex 系列模型兼容性更强，更适合代码理解、修改、测试和仓库级工程任务，并提供额外的路由与回退选择。智能体 1 仍可通过模型和能力配置完成代码、研究等任务。'}
                          </p>
                        </div>
                        {agent.status !== 'installed' && (
                          <div className="agent-readiness-actions">
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => window.open(agent.installUrl, '_blank', 'noopener,noreferrer')}
                            >
                              查看安装说明
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="routing-section-note">自动路由只会在当前智能体支持且你选中的模型池中进行选择。</p>
                <div className="routing-stack">
                  {Object.entries(draft).filter(([ref]) => ref !== 'planner').map(([ref, entry]) => {
                    const agentFacts = facts[ref];
                    if (!agentFacts) return null;
                    return (
                      <AgentClassConfig
                        key={ref}
                        facts={agentFacts}
                        draft={entry}
                        models={Object.values(catalog.models)}
                        providers={Object.values(catalog.providers)}
                        manualPreview={manualPreviews[ref]}
                        onUpdateManual={() => { void updateManual(ref); }}
                        onChange={next => {
                          setDraft(current => current ? { ...current, [ref]: next } : current);
                          if (
                            agentFacts.kind === 'executor'
                            && next.executorManualSourceText.trim()
                              !== entry.executorManualSourceText.trim()
                          ) {
                            setManualPreviews(current => ({
                              ...current,
                              [ref]: {
                                ...current[ref],
                                status: 'stale',
                                sourceText: next.executorManualSourceText,
                              },
                            }));
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </section>

              <details className="settings-section advanced-settings">
                <summary>高级设置</summary>
                <div className="advanced-settings-body">
                  <section className="runtime-policy-section">
                    <div className="section-heading">
                      <div>
                        <div className="settings-eyebrow">PLANNER AND RUNTIME</div>
                        <h3>并行与队列</h3>
                        <p>不同会话可并行执行；同一会话的后续任务会排队。</p>
                      </div>
                    </div>
                    <div className="runtime-policy-grid">
                      <label className="settings-field">
                        <span>同时运行任务数</span>
                        <input
                          className="text-input"
                          type="number"
                          min={1}
                          max={8}
                          value={runtimePolicy.maxConcurrentTasks}
                          onChange={event => setRuntimePolicy(current => current ? {
                            ...current,
                            maxConcurrentTasks: Number(event.target.value),
                          } : current)}
                        />
                        <small>最多同时运行多少个会话任务；同一会话内仍按顺序执行。</small>
                      </label>
                    </div>
                    <div className="routing-section-note">
                      降低上限不会取消当前运行中的任务，只影响下一轮调度。
                    </div>
                  </section>
                  {plannerSection}
                </div>
              </details>
            </div>
          )}

          {routingPrecheckWarnings.length > 0 && (
            <div className="result-banner result-error">
              以下模型绑定缺少必需能力（保存前预检）：
              <ul className="issues">
                {routingPrecheckWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
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
          <footer className="drawer-footer settings-footer">
            <div className="settings-footer-note">
              {plannerDirty
                ? '注意：规划设置有未更新的修改，本次「保存并激活」不会应用它——请在高级设置中单独更新。'
                : '「保存并激活」只应用模型列表、智能体路由与运行时策略，不包含规划设置。'}
            </div>
            <div className="settings-footer-actions">
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
            </div>
          </footer>
        )}
        <ModelConnectionDialog
          open={modelDialogOpen}
          disabled={editingDisabled}
          onCancel={() => setModelDialogOpen(false)}
          onConfirm={createModelConnection}
        />
      </div>
    </div>
  );
}
