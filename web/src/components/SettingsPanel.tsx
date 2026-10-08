import { ModelCapabilityDetails } from './ModelCapabilityDetails';
import { sameAiText, aiActionError, type ResponsibilityRewriteFeedback } from './AiActionStatus';
import { useEffect, useRef, useState } from 'react';
import type { HttpClient } from '../api/http';
import type {
  ActivateResult,
  AgentReadiness,
  ConfigSnapshot,
  ConfigurationCompletionResult,
  ConfigurationRuntimeState,
  ResponsibilitySuggestion,
  ProviderCredentialStatus,
  ExecutorManagementView,
  ExecutorConfigurationChange,
  ExecutorEditableFields,
  PreparedExecutorConfiguration,
  ModelPublicFacts,
} from '../api/types';
import {
  fingerprintProviderCredential,
  maskApiKey,
  providerIdentityKey,
  currentProviderIdentityKey,
  resolveProviderSecretReferenceFromConfiguration,
} from './provider-secret-state';
import {
  SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
  buildSpanRoutingSection,
  loadSpanRoutingDraft,
  type SpanRoutingDraft,
} from '../config-edit';
import { SpanRoutingSettings } from './SpanRoutingSettings';
import { ModelConnectionDialog, type NewModelConnectionDraft } from './ModelConnectionDialog';
import { ExecutorEditorDialog } from './ExecutorEditorDialog';
import { applyExecutorSnapshot } from '../executor-management';
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
  evaluateModelCompatibility,
  resolveAgentDisplayName,
  resolveProviderDisplayName,
  resolveConfiguredModelRef,
  type AgentClassRoutingFacts,
  type AgentClassRoutingDraft,
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

type OpenRouterCandidate = {
  modelId: string;
  displayName?: string;
  description?: string;
  score: number;
  match: 'exact-id' | 'canonical-id' | 'display-name' | 'token-overlap';
};

function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase()
    .replace(/\s+/gu, '-')
    .replace(/[^a-z0-9]+/gu, '-');
}

function canonicalModelKey(value: string): string {
  const last = value.trim().toLowerCase().split('/').at(-1) ?? '';
  return normalizeModelKey(last.replace(/:(?:free|batch|nitro|exact)$/u, ''));
}

function modelTokens(value: string): string[] {
  return normalizeModelKey(value).split('-').filter(token => token.length > 1
    && !['openai', 'anthropic', 'google', 'meta', 'mistral'].includes(token));
}

function rankOpenRouterCandidates(
  modelId: string,
  discovery: {
    modelIds?: string[];
    metadata?: Record<string, { displayName?: string; description?: string }>;
  } | undefined,
): OpenRouterCandidate[] {
  if (!modelId.trim() || !discovery) return [];
  const normalized = normalizeModelKey(modelId);
  const canonical = canonicalModelKey(modelId);
  const localTokens = new Set(modelTokens(modelId));
  return [...new Set([
    ...(discovery.modelIds ?? []),
    ...Object.keys(discovery.metadata ?? {}),
  ])].flatMap(candidateId => {
    const metadata = discovery.metadata?.[candidateId];
    const idKey = normalizeModelKey(candidateId);
    const candidateCanonical = canonicalModelKey(candidateId);
    const displayKey = normalizeModelKey(metadata?.displayName ?? '');
    const candidateTokens = modelTokens(`${candidateId} ${metadata?.displayName ?? ''}`);
    let score = 0;
    let match: OpenRouterCandidate['match'] = 'token-overlap';
    if (idKey === normalized) { score = 100; match = 'exact-id'; }
    else if (candidateCanonical === canonical) { score = 96; match = 'canonical-id'; }
    else if (displayKey && displayKey === normalized) { score = 94; match = 'display-name'; }
    else {
      const overlap = [...new Set(candidateTokens)].filter(token => localTokens.has(token)).length;
      if (overlap === 0) return [];
      const coverage = overlap / Math.max(1, localTokens.size);
      const precision = overlap / Math.max(1, new Set(candidateTokens).size);
      score = Math.round(52 + 30 * coverage + 12 * precision);
      if (score < 58) return [];
    }
    return [{ modelId: candidateId, ...(metadata ?? {}), score, match }];
  }).sort((left, right) => right.score - left.score || left.modelId.localeCompare(right.modelId));
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
        ...(completed?.credentialFingerprint ? { credentialFingerprint: completed.credentialFingerprint } : {}),
        credentialState: completed?.credentialState ?? '需要确认',
        enabled: provider.enabled !== false,
        ...(provider.systemManaged === true ? { systemManaged: true } : {}),
      },
    ];
  }));
  for (const [providerRef, completed] of Object.entries(completionProviders)) {
    const baseUrl = completed.baseUrl ?? '';
    if (
      providers[providerRef]
      || completed.credentialState === '缺失'
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
      ...(completed.credentialFingerprint ? { credentialFingerprint: completed.credentialFingerprint } : {}),
        credentialState: completed.credentialState,
        enabled: true,
    };
  }
  const providerAliases: Record<string, string> = {};
  const identityOwners = new Map<string, string>();
  for (const provider of Object.values(providers)) {
    const identity = providerIdentityKey(provider);
    if (!identity) continue;
    const owner = identityOwners.get(identity);
    if (!owner) {
      identityOwners.set(identity, provider.providerRef);
      continue;
    }
    providerAliases[provider.providerRef] = owner;
    const primary = providers[owner];
    if (primary) {
      primary.modelIds = [...new Set([...primary.modelIds, ...provider.modelIds])]
        .sort((left, right) => left.localeCompare(right));
    }
    delete providers[provider.providerRef];
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
        providerRef: providerAliases[String(model.providerRef ?? '')]
          ?? String(model.providerRef ?? ''),
        modelId: String(model.modelId ?? ref),
        ...(model.systemManaged === true ? { systemManaged: true } : {}),
        ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : completedModel?.displayName ? { displayName: completedModel.displayName } : {}),
        ...(typeof model.description === 'string' ? { description: model.description } : completedModel?.description ? { description: completedModel.description } : {}),
        ...(model.publicFacts && typeof model.publicFacts === 'object'
          ? { publicFacts: model.publicFacts as ModelPublicFacts }
          : completedModel?.publicFacts ? { publicFacts: completedModel.publicFacts } : {}),
        capabilities,
        capabilityState: completedModel?.capabilityState
          ?? (capabilities.length > 0 ? '已自动发现' : '需要确认'),
        ...(typeof model.contextLimit === 'number' ? { contextLimit: model.contextLimit } : {}),
        ...(typeof model.costInputPerMillion === 'number'
          ? { costInputPerMillion: model.costInputPerMillion }
          : completedModel?.costInputPerMillion !== undefined
            ? { costInputPerMillion: completedModel.costInputPerMillion }
            : {}),
        ...(typeof model.costOutputPerMillion === 'number'
          ? { costOutputPerMillion: model.costOutputPerMillion }
          : completedModel?.costOutputPerMillion !== undefined
            ? { costOutputPerMillion: completedModel.costOutputPerMillion }
            : {}),
        ...(model.pricing && typeof model.pricing === 'object'
          ? { pricing: model.pricing as ModelDraft['pricing'] }
          : completedModel?.pricing && typeof completedModel.pricing === 'object'
            ? { pricing: completedModel.pricing }
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
  const modelEntries = Object.entries(asRecord(config.models)).map(([ref, raw]) => {
    const model = asRecord(raw);
    return {
      ref,
      providerRef: String(model.providerRef ?? ''),
      modelId: String(model.modelId ?? ref),
    };
  });
  const modelRefs = modelEntries
    .filter(model => /^[a-z][a-z0-9-]{0,63}$/u.test(model.ref))
    .map(model => model.ref);
  return Object.fromEntries(Object.entries(rawAgentClasses).map(([agentClassRef, raw]) => {
    const agentClass = asRecord(raw);
    const policy = asRecord(agentClass.modelPolicy);
    const isPlanner = agentClass.kind === 'planner' || agentClassRef === 'planner';
    const mode = isPlanner || policy.mode !== 'auto' ? 'fixed' : 'auto';
    const allowedModelRefs = mode === 'auto'
      ? [...new Set(stringList(policy.allowedModelRefs)
        .map(ref => resolveConfiguredModelRef(ref, modelEntries))
        .filter(ref => modelRefs.includes(ref)))]
      : [];
    const modelRef = resolveConfiguredModelRef(
      typeof policy.modelRef === 'string'
        ? policy.modelRef
        : typeof policy.defaultModelRef === 'string'
          ? policy.defaultModelRef
          : modelRefs[0] ?? '',
      modelEntries,
    );
    const fallback = asRecord(policy.objective);
    return [
      agentClassRef,
      {
        enabled: agentClass.enabled !== false,
        displayName: resolveAgentDisplayName(
          agentClassRef,
          typeof agentClass.displayName === 'string' ? agentClass.displayName : undefined,
        ),
        responsibility: isPlanner
          ? '理解用户意图，拆解任务为 DAG 图，选择执行智能体并完成编排规划。'
          : typeof agentClass.responsibility === 'string'
            ? agentClass.responsibility : '',
        mode,
        modelRef,
        allowedModelRefs: allowedModelRefs.length > 0
          ? allowedModelRefs
          : modelRef ? [modelRef] : modelRefs.slice(0, 1),
        defaultModelRef: resolveConfiguredModelRef(
          typeof policy.defaultModelRef === 'string'
            ? policy.defaultModelRef
            : allowedModelRefs[0] ?? modelRefs[0] ?? '',
          modelEntries,
        ),
        fallbackModelRefs: [...new Set(stringList(asRecord(policy.fallback).order)
          .map(ref => resolveConfiguredModelRef(ref, modelEntries))
          .filter(ref => modelRefs.includes(ref)))],
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
        enabled: agentClass.enabled !== false,
        displayName: resolveAgentDisplayName(
          agentClassRef,
          typeof agentClass.displayName === 'string' ? agentClass.displayName : undefined,
        ),
        responsibility: typeof agentClass.responsibility === 'string'
          ? agentClass.responsibility : '',
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

function responsibilityRequestKey(entry: AgentClassRoutingDraft, catalog: CatalogDraft): string {
  const refs = entry.mode === 'fixed' ? [entry.modelRef] : [...entry.allowedModelRefs].sort();
  return JSON.stringify({ responsibility: entry.responsibility, mode: entry.mode,
    defaultModelRef: entry.defaultModelRef, models: refs.map(ref => catalog.models[ref] ?? { ref }) });
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
  const [spanDraft, setSpanDraft] = useState<SpanRoutingDraft>({
    enabled: false,
    model: 'inception/mercury-decide:free',
    timeoutMs: SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
    apiKey: '',
  });
  const [spanCredentialConfigured, setSpanCredentialConfigured] = useState(false);
  const [newModelIds, setNewModelIds] = useState<Record<string, string>>({});
  const [capabilityCatalog, setCapabilityCatalog] = useState<Record<string, string[]>>({});
  const [modelDiscoveries, setModelDiscoveries] = useState<Record<string, {
    status: 'loading' | 'ready' | 'error';
    modelIds?: string[];
    capabilities?: Record<string, string[]>;
    metadata?: Record<string, {
      displayName?: string;
      description?: string;
      publicFacts?: ModelPublicFacts;
      contextLimit?: number;
      costInputPerMillion?: number;
      costOutputPerMillion?: number;
      pricing?: SettingsModelEntry['pricing'];
    }>;
    prices?: Record<string, {
      inputCnyPerMillion?: number;
      outputCnyPerMillion?: number;
      pricing?: {
        source: 'openrouter' | 'catalog' | 'user';
        usdInputPerToken?: number;
        usdOutputPerToken?: number;
        exchangeRate: 7;
        fetchedAt?: string;
        catalogModelId?: string;
      };
    }>;
    message?: string;
  }>>({});
  const [result, setResult] = useState<ActivateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelEditRef, setModelEditRef] = useState<string | null>(null);
  const [executorView, setExecutorView] = useState<ExecutorManagementView | null>(null);
  const [executorDefinitions, setExecutorDefinitions] = useState<Record<string, RawRecord>>({});
  const [executorPermissionProfiles, setExecutorPermissionProfiles] = useState<RawRecord>({});
  const [executorEditorConfig, setExecutorEditorConfig] = useState<RawRecord>({});
  const [executorEditor, setExecutorEditor] = useState<{
    operation: ExecutorConfigurationChange['operation']; agentClassRef?: string;
  } | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [responsibilityFeedback, setResponsibilityFeedback] = useState<Record<string, ResponsibilityRewriteFeedback>>({});
  const responsibilityRequests = useRef(new Map<string, symbol>());
  const latestResponsibilityContext = useRef({ draft, catalog, revisionId });
  latestResponsibilityContext.current = { draft, catalog, revisionId };
  useEffect(() => () => { responsibilityRequests.current.clear(); }, []);
  const [modelAddLoading, setModelAddLoading] = useState<string | null>(null);
  const [modelInfoLoading, setModelInfoLoading] = useState<string | null>(null);
  const [modelInfoStatus, setModelInfoStatus] = useState<Record<string, {
    status: 'loading' | 'success' | 'error';
    message: string;
    candidates?: OpenRouterCandidate[];
  }>>({});
  const [executorLoading, setExecutorLoading] = useState(false);
  const secretStatusVersion = useRef(0);
  const completionCache = useRef<ConfigurationCompletionResult>();

  const applyConfigSnapshot = (
    snapshot: ConfigSnapshot,
    completion?: ConfigurationCompletionResult,
  ) => {
    const config = snapshot.config as RawRecord;
    setRevisionId(snapshot.revisionId);
    setExecutorDefinitions({});
    setExecutorPermissionProfiles({});
    setCatalog(loadCatalog(config, completion));
    setRuntimePolicy(loadRuntimePolicy(config));
    setSpanDraft(loadSpanRoutingDraft(config));
    const nextDraft = loadRoutingDraft(config);
    setDraft(nextDraft);
    setFacts(loadRoutingFacts(config));
    responsibilityRequests.current.clear();
    setResponsibilityFeedback({});
    setExpandedProviders(new Set());
    setExpandedAgents(new Set());
  };

  useEffect(() => {
    setActivationState(runtime);
  }, [runtime]);

  useEffect(() => {
    if (!http || !revisionId) return;
    let cancelled = false;
    void http.getSpanCredentialStatus().then(status => {
      if (!cancelled) setSpanCredentialConfigured(status.configured);
    }).catch(() => { if (!cancelled) setSpanCredentialConfigured(false); });
    return () => { cancelled = true; };
  }, [http, revisionId]);

  useEffect(() => {
    if (!http || !revisionId) return;
    let cancelled = false;
    void http.getExecutorManagement().then(view => {
      if (!cancelled) setExecutorView(view);
    }).catch(() => { if (!cancelled) setExecutorView(null); });
    return () => { cancelled = true; };
  }, [http, revisionId]);

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
              maskedApiKey: existence[ref]?.maskedApiKey ?? provider.maskedApiKey ?? null,
              credentialFingerprint: existence[ref]?.credentialFingerprint ?? provider.credentialFingerprint,
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

  const refreshConfigurationCompletion = async (refreshPublicCatalog = true) => {
    if (!http) return;
    const [snapshot, publicCompletion] = await Promise.all([
      http.getConfig(),
      refreshPublicCatalog || !completionCache.current
        ? http.getConfigurationCompletion()
        : Promise.resolve(completionCache.current),
    ]);
    completionCache.current = publicCompletion;
    // A saved revision is the authority for membership and model facts. Do not
    // resurrect deleted Providers or old model metadata from the catalog cache.
    const completion: ConfigurationCompletionResult = refreshPublicCatalog ? publicCompletion : {
      ...publicCompletion,
      models: {},
      requiredFields: [],
      providers: Object.fromEntries(Object.entries(asRecord((snapshot.config as RawRecord).providers)).map(([ref, raw]) => {
        const provider = asRecord(raw);
        const cached = publicCompletion.providers[ref];
        return [ref, {
          displayName: typeof provider.displayName === 'string' ? provider.displayName : cached?.displayName ?? resolveProviderDisplayName(ref),
          baseUrl: String(provider.baseUrl ?? ''),
          modelIds: cached?.baseUrl === provider.baseUrl ? cached.modelIds : [],
          credentialState: '需要确认' as const,
        }];
      })),
    };
    setCapabilityCatalog(completion.modelCapabilityCatalog ?? {});
    const existence = await http.getSecretStatus(Object.keys(completion.providers))
      .catch((): Record<string, ProviderCredentialStatus> => ({}));
    applyConfigSnapshot(snapshot, {
      ...completion,
      providers: Object.fromEntries(
        Object.entries(completion.providers).map(([providerRef, provider]) => [
          providerRef,
          existence[providerRef]?.configured
            ? {
              ...provider,
              maskedApiKey: existence[providerRef]?.maskedApiKey ?? null,
              credentialFingerprint: existence[providerRef]?.credentialFingerprint,
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
      if (agentFacts.enabled === false || entry.enabled === false) continue;
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
          + '，激活或任务调度会被拒绝（请刷新 Provider 公开模型目录）',
        );
      }
    }
    return [...new Set(warnings)];
  })();
  const editingDisabled = loading || executorLoading;

  const openExecutorEditor = async (
    operation: ExecutorConfigurationChange['operation'], agentClassRef?: string,
  ) => {
    if (!http || editingDisabled) return;
    if (executorView && (operation === 'enable' || operation === 'disable' || operation === 'remove')) {
      setExecutorEditor({ operation, agentClassRef });
      return;
    }
    setExecutorLoading(true);
    try {
      const snapshot = await http.getConfig();
      if (snapshot.revisionId !== revisionId) {
        setLoadError('配置已在其他窗口更新。请先重新打开设置，再管理智能体。');
        return;
      }
      const config = buildCandidateConfiguration(snapshot.config as RawRecord).config;
      const view = await http.getExecutorManagement(config);
      if (view.baseRevisionId !== revisionId) {
        setLoadError('配置已在其他窗口更新。当前草稿已保留，请检查后重试。');
        return;
      }
      setExecutorEditorConfig(config);
      setExecutorView(view);
      setExecutorEditor({ operation, agentClassRef });
    } catch (error) { setLoadError((error as Error).message); }
    finally { setExecutorLoading(false); }
  };

  const executorSaved = (candidate: PreparedExecutorConfiguration, agentClassRef: string) => {
    setExecutorPermissionProfiles(asRecord(candidate.config.permissionProfiles));
    const nextDraft = loadRoutingDraft(candidate.config);
    const nextFacts = loadRoutingFacts(candidate.config);
    const definition = asRecord(asRecord(candidate.config.agentClasses)[agentClassRef]);
    setExecutorDefinitions(current => ({ ...current, [agentClassRef]: definition }));
    setDraft(current => applyExecutorSnapshot(current ?? {}, nextDraft, agentClassRef));
    setFacts(current => applyExecutorSnapshot(current ?? {}, nextFacts, agentClassRef));
    setExecutorView(current => current ? { ...current, executors: [
      ...current.executors.filter(agent => agent.agentClassRef !== agentClassRef),
      {
        agentClassRef, tool: nextFacts[agentClassRef].driverId === 'codex-cli' ? 'codex' : 'pi',
        displayName: String(definition.displayName ?? agentClassRef),
        enabled: definition.enabled !== false,
        operations: current.executors.find(agent => agent.agentClassRef === agentClassRef)?.operations ?? 'standard',
        manualSourceText: String(asRecord(definition.executorManual).sourceText ?? ''),
        modelPolicy: definition.modelPolicy as ExecutorEditableFields['modelPolicy'],
      },
    ] } : current);
    setExecutorEditor(null);
    setResult(null);
    setLoadError(null);
  };

  const executorRemoved = (agentClassRef: string) => {
    setDraft(current => {
      if (!current?.[agentClassRef]) return current;
      const next = { ...current };
      delete next[agentClassRef];
      return next;
    });
    setFacts(current => {
      if (!current?.[agentClassRef]) return current;
      const next = { ...current };
      delete next[agentClassRef];
      return next;
    });
    setExecutorView(current => current
      ? { ...current, executors: current.executors.filter(agent => agent.agentClassRef !== agentClassRef) }
      : current);
    setExpandedAgents(current => {
      const next = new Set(current);
      next.delete(agentClassRef);
      return next;
    });
    setExecutorEditor(null);
    setResult(null);
    setLoadError(null);
  };

  const executorEnabled = (agentClassRef: string, enabled: boolean) => {
    setDraft(current => current?.[agentClassRef]
      ? { ...current, [agentClassRef]: { ...current[agentClassRef], enabled } } : current);
    setFacts(current => current?.[agentClassRef]
      ? { ...current, [agentClassRef]: { ...current[agentClassRef], enabled } } : current);
    setExecutorView(current => current ? { ...current, executors: current.executors.map(agent =>
      agent.agentClassRef === agentClassRef ? { ...agent, enabled } : agent) } : current);
    setExecutorEditor(null);
    setResult(null);
  };

  const buildCandidateConfiguration = (originalConfig: RawRecord): {
    config: Record<string, unknown>;
    activationSecrets: Record<string, string>;
    spanApiKey?: string;
  } => {
    if (!draft || !catalog || !runtimePolicy) {
      throw new Error('配置草稿尚未加载完成');
    }
    const originalProviders = asRecord(originalConfig.providers);
    const originalAgentClasses = { ...asRecord(originalConfig.agentClasses), ...executorDefinitions };
    const harnesses = { ...asRecord(originalConfig.harnesses) };
    const spanRoutingSection = buildSpanRoutingSection(spanDraft, originalConfig);
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
      const {
        costInputPerMillion: _oldInputPrice,
        costOutputPerMillion: _oldOutputPrice,
        pricing: _oldPricing,
        ...originalModelWithoutPrices
      } = originalModel;
      models[model.ref] = {
        ...(sameIdentity ? originalModelWithoutPrices : {}),
        modelId: model.modelId,
        providerRef: model.providerRef,
        ...(model.description ? { description: model.description } : {}),
        ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),
        capabilities: model.capabilities,
        ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
        ...(model.costInputPerMillion !== undefined
          ? { costInputPerMillion: model.costInputPerMillion }
          : {}),
        ...(model.costOutputPerMillion !== undefined
          ? { costOutputPerMillion: model.costOutputPerMillion }
          : {}),
        ...(model.pricing ? { pricing: model.pricing } : {}),
        ...(model.latencyTier ? { latencyTier: model.latencyTier } : {}),
        ...(model.qualityTier ? { qualityTier: model.qualityTier } : {}),
        ...(model.costTier ? { costTier: model.costTier } : {}),
        routingNotes: hasRoutingNotes(model.routingNotes) ? model.routingNotes : undefined,
        reasoning: model.reasoning ?? (sameIdentity ? originalModel.reasoning : undefined) ?? 'high',
        enabled: model.enabled !== false,
      };
    }

    const configuredModels = Object.values(catalog.models);
    for (const [ref, entry] of Object.entries(draft)) {
      const current = asRecord(originalAgentClasses[ref]);
      const currentManual = asRecord(current.executorManual);
      const manualSourceText = entry.executorManualSourceText.trim();
      const currentSourceText = typeof currentManual.sourceText === 'string'
        ? currentManual.sourceText.trim()
        : '';
      const unchangedSource = currentSourceText === manualSourceText;
      const normalizedAssertions = unchangedSource && Array.isArray(currentManual.assertions)
        ? currentManual.assertions : [];
      const assertionsSourceFingerprint = unchangedSource
        ? optionalString(currentManual.assertionsSourceFingerprint) : undefined;
      const semanticReceipt = unchangedSource ? optionalString(currentManual.semanticReceipt) : undefined;
      const fixedModelRef = resolveConfiguredModelRef(entry.modelRef, configuredModels);
      const allowedModelRefs = [...new Set(entry.allowedModelRefs
        .map(modelRef => resolveConfiguredModelRef(modelRef, configuredModels))
        .filter(Boolean))];
      const defaultModelRef = resolveConfiguredModelRef(entry.defaultModelRef, configuredModels);
      const fallbackModelRefs = [...new Set((entry.fallbackModelRefs ?? [])
        .map(modelRef => resolveConfiguredModelRef(modelRef, configuredModels))
        .filter(Boolean))];
      agentClasses[ref] = {
        ...current,
        enabled: entry.enabled ?? current.enabled,
        displayName: (entry.displayName ?? '').trim(),
        responsibility: entry.responsibility.trim(),
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
            allowedModelRefs,
            defaultModelRef: defaultModelRef || undefined,
            fallback: {
              enabled: fallbackModelRefs.length > 0,
              order: fallbackModelRefs,
            },
            objective: {
              priority: entry.objective,
              minimumQualityTier: entry.minimumQualityTier,
            },
          }
          : { mode: 'fixed', modelRef: fixedModelRef },
      };
      if (entry.enabled === true && typeof current.harnessRef === 'string' && harnesses[current.harnessRef]) {
        harnesses[current.harnessRef] = { ...asRecord(harnesses[current.harnessRef]), enabled: true };
      }
    }

    return {
      config: {
        ...originalConfig,
        providers,
        models,
        permissionProfiles: { ...asRecord(originalConfig.permissionProfiles), ...executorPermissionProfiles },
        agentClasses,
        harnesses,
        ...(spanRoutingSection ? { routing: spanRoutingSection } : {}),
        runtimePolicy: {
          ...asRecord(originalConfig.runtimePolicy),
          ...runtimePolicy,
        },
      },
      activationSecrets,
      ...(spanDraft.apiKey.trim() ? { spanApiKey: spanDraft.apiKey.trim() } : {}),
    };
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
        config: full.config,
        activationSecrets: full.activationSecrets,
        spanApiKey: full.spanApiKey,
      };
      const response = await http.activate(
        revisionId,
        candidate.config,
        candidate.activationSecrets,
        candidate.spanApiKey,
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
        setSpanDraft(current => ({ ...current, apiKey: '' }));
        void http.getSpanCredentialStatus().then(status => {
          setSpanCredentialConfigured(status.configured);
        }).catch(() => undefined);
        try {
          // Activation is already committed. Refresh local configuration and
          // credential status without waiting on OpenRouter catalog retrieval.
          await refreshConfigurationCompletion(false);
        } catch {
          setLoadError('配置已激活，但页面刷新失败。请重新打开设置查看最新配置。');
        }
      }
    } catch (error) {
      setResult({ ok: false, code: 'network', issues: [(error as Error).message] });
    } finally {
      setLoading(false);
    }
  };

  const suggestResponsibility = async (agentClassRef: string): Promise<void> => {
    if (!http || !draft?.[agentClassRef] || !catalog) return;
    if (responsibilityRequests.current.has(agentClassRef)) return;
    const requestId = Symbol(agentClassRef);
    responsibilityRequests.current.set(agentClassRef, requestId);
    const before = draft[agentClassRef].responsibility;
    const startedAt = Date.now();
    const inputKey = responsibilityRequestKey(draft[agentClassRef], catalog);
    const requestRevision = revisionId;
    setResponsibilityFeedback(current => ({ ...current, [agentClassRef]: { status: 'loading', before, startedAt } }));
    try {
      const signal = AbortSignal.timeout(150_000);
      const suggestion: ResponsibilitySuggestion = await http.suggestAgentResponsibility({
        agentClassRef,
        sourceText: draft[agentClassRef].responsibility,
        modelFacts: (() => {
          const entry = draft[agentClassRef];
          const refs = entry.mode === 'fixed'
            ? [entry.modelRef]
            : [...new Set([entry.defaultModelRef, ...entry.allowedModelRefs])];
          return refs.flatMap(ref => {
            const model = catalog.models[ref];
            return model ? [{
              modelRef: model.ref,
              modelId: model.modelId,
              capabilities: model.capabilities,
              ...(model.description ? { description: model.description } : {}),
              ...(model.routingNotes ? { routingNotes: model.routingNotes } : {}),
              ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
              ...(model.costInputPerMillion !== undefined ? { costInputPerMillion: model.costInputPerMillion } : {}),
              ...(model.costOutputPerMillion !== undefined ? { costOutputPerMillion: model.costOutputPerMillion } : {}),
              ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),
            }] : [];
          });
        })(),
        config: buildCandidateConfiguration((await http.getConfig(signal)).config as RawRecord).config,
      }, signal);
      if (responsibilityRequests.current.get(agentClassRef) !== requestId) return;
      const latest = latestResponsibilityContext.current;
      const entry = latest.draft?.[agentClassRef];
      const stale = !entry || !latest.catalog || requestRevision !== latest.revisionId
        || inputKey !== responsibilityRequestKey(entry, latest.catalog);
      const unchanged = sameAiText(before, suggestion.suggestedText);
      if (!stale && !unchanged) {
        setDraft(current => current && current[agentClassRef] ? {
          ...current, [agentClassRef]: {
            ...current[agentClassRef], responsibility: suggestion.suggestedText,
            executorManualSourceText: suggestion.suggestedText,
          },
        } : current);
      }
      setResponsibilityFeedback(current => ({ ...current, [agentClassRef]: {
        status: stale ? 'stale' : unchanged ? 'unchanged' : 'updated', before,
        after: unchanged ? before : suggestion.suggestedText, startedAt, completedAt: Date.now(),
      } }));
    } catch (error) {
      if (responsibilityRequests.current.get(agentClassRef) !== requestId) return;
      setResponsibilityFeedback(current => ({ ...current, [agentClassRef]: {
        status: 'error', before, startedAt, completedAt: Date.now(), message: aiActionError(error),
      } }));
    } finally {
      if (responsibilityRequests.current.get(agentClassRef) === requestId) responsibilityRequests.current.delete(agentClassRef);
    }
  };

  const createModelConnection = async (connection: NewModelConnectionDraft): Promise<void> => {
    const credentialFingerprint = await fingerprintProviderCredential(connection.apiKey);
    const identity = await currentProviderIdentityKey({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      credentialFingerprint,
    });
    const candidates = await Promise.all(Object.values(catalog?.providers ?? {}).map(async provider => ({
      provider, identity: await currentProviderIdentityKey(provider),
    })));
    const duplicate = identity && candidates.find(candidate => candidate.identity === identity)?.provider;
    if (duplicate) {
      setExpandedProviders(current => new Set(current).add(duplicate.providerRef));
      setModelDialogOpen(false);
      setLoadError(`该 Base URL 和 API Key 已存在于「${duplicate.displayName || duplicate.providerRef}」，已展开现有 Provider。`);
      return;
    }
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
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
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
    setExpandedProviders(current => new Set(current).add(providerRef));
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
    setExpandedProviders(current => {
      const next = new Set(current);
      next.delete(providerRef);
      return next;
    });
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

  const updateModelPrice = (
    modelRef: string,
    field: 'costInputPerMillion' | 'costOutputPerMillion',
    value: string,
  ) => {
    const trimmed = value.trim();
    const parsed = trimmed === '' ? undefined : Number(trimmed);
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) return;
    setCatalog(current => {
      if (!current) return current;
      const model = current.models[modelRef];
      if (!model) return current;
      const nextModel = { ...model };
      if (parsed === undefined) delete nextModel[field];
      else nextModel[field] = parsed;
      nextModel.pricing = {
        ...(nextModel.pricing ?? { exchangeRate: 7 }),
        source: 'user',
        exchangeRate: 7,
        overrideReason: '用户在设置中手动修改人民币价格',
      };
      return { ...current, models: { ...current.models, [modelRef]: nextModel } };
    });
  };

  const updateModelId = (modelRef: string, modelId: string): void => {
    setCatalog(current => {
      if (!current) return current;
      const model = current.models[modelRef];
      if (!model || !modelId.trim()) return current;
      const nextId = modelId.trim();
      const discovery = modelDiscoveries[model.providerRef];
      const metadata = discovery?.metadata?.[nextId];
      const discoveredPrice = discovery?.prices?.[nextId];
      const capabilities = [...new Set([
        ...(discovery?.capabilities?.[nextId] ?? []),
        ...capabilitiesForModelId(nextId),
      ])].sort();
      const nextModel: ModelDraft = {
        ...model,
        modelId: nextId,
        capabilities,
        capabilityState: capabilities.length > 0 ? '已从 Provider 补全' : '需要确认',
        ...(metadata?.displayName ? { displayName: metadata.displayName } : {}),
        ...(metadata?.description ? { description: metadata.description } : {}),
        ...(metadata?.publicFacts ? { publicFacts: metadata.publicFacts } : {}),
        ...(metadata?.contextLimit !== undefined ? { contextLimit: metadata.contextLimit } : {}),
        ...(discoveredPrice?.inputCnyPerMillion !== undefined ? { costInputPerMillion: discoveredPrice.inputCnyPerMillion } : {}),
        ...(discoveredPrice?.outputCnyPerMillion !== undefined ? { costOutputPerMillion: discoveredPrice.outputCnyPerMillion } : {}),
        ...(discoveredPrice?.pricing ? { pricing: discoveredPrice.pricing } : {}),
      };
      if (!metadata?.displayName) delete nextModel.displayName;
      if (!metadata?.description) delete nextModel.description;
      if (nextId !== model.modelId) {
        delete nextModel.routingNotes;
        if (!metadata?.publicFacts) delete nextModel.publicFacts;
      }
      return {
        ...current,
        models: {
          ...current.models,
          [modelRef]: nextModel,
        },
      };
    });
  };

  const updateModelNumber = (
    modelRef: string,
    field: 'contextLimit',
    value: string,
  ): void => {
    const parsed = value.trim() === '' ? undefined : Number(value);
    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 1_024)) return;
    setCatalog(current => {
      if (!current?.models[modelRef]) return current;
      const model = { ...current.models[modelRef] };
      if (parsed === undefined) delete model[field]; else model[field] = parsed;
      return { ...current, models: { ...current.models, [modelRef]: model } };
    });
  };

  const updateModelString = (
    modelRef: string,
    field: 'reasoning' | 'latencyTier' | 'qualityTier' | 'costTier',
    value: string,
  ): void => {
    setCatalog(current => {
      if (!current?.models[modelRef]) return current;
      const model = { ...current.models[modelRef], [field]: value || undefined };
      return { ...current, models: { ...current.models, [modelRef]: model } };
    });
  };

  const capabilitiesForModelId = (modelId: string): string[] => (
    [...new Set(capabilityCatalog[modelId] ?? [])].sort()
  );

  const summarizeRoutingProfile = async (catalogModelId?: string): Promise<{
    routingNotes?: ModelDraft['routingNotes']; routingError?: string;
  }> => {
    if (!http || !catalogModelId) return {};
    try {
      const result = await http.summarizeModelInformation(catalogModelId);
      return { routingNotes: result.routingNotes };
    } catch (error) {
      const routingError = `公开信息已获取，但能力描述整理失败：${(error as Error).message}`;
      setLoadError(routingError);
      return { routingError };
    }
  };

  const fetchOpenRouterFactsForModel = async (
    providerRef: string,
    modelId: string,
    forceRefresh = false,
  ): Promise<{
    matchedId?: string;
    candidates: OpenRouterCandidate[];
    capabilities: string[];
    metadata?: NonNullable<import('../api/types').ProviderModelDiscoveryResult['metadata']>[string];
    price?: NonNullable<import('../api/types').ProviderModelDiscoveryResult['prices']>[string];
    routingNotes?: ModelDraft['routingNotes'];
    routingError?: string;
  }> => {
    const cached = modelDiscoveries[providerRef];
    const cachedCandidates = rankOpenRouterCandidates(modelId, cached);
    const cachedBest = cachedCandidates[0];
    const cachedMatchedId = cachedBest && cachedBest.score >= 94
      ? cachedBest.modelId : undefined;
    if (!forceRefresh && cachedMatchedId) {
      return {
        ...(await summarizeRoutingProfile(cachedMatchedId)),
        matchedId: cachedMatchedId,
        candidates: cachedCandidates,
        capabilities: cached.capabilities?.[cachedMatchedId] ?? [],
        metadata: cached.metadata?.[cachedMatchedId],
        price: cached.prices?.[cachedMatchedId],
      };
    }
    if (!http) return {
      candidates: [] as OpenRouterCandidate[],
      capabilities: [] as string[],
      metadata: undefined,
      price: undefined,
    };
    try {
      const result = await http.discoverProviderModels({ baseUrl: 'https://openrouter.ai/api/v1' });
      if (result.status !== 'discovered') return {
        candidates: [] as OpenRouterCandidate[],
        capabilities: [] as string[],
        metadata: undefined,
        price: undefined,
      };
      const discovery = {
        modelIds: result.modelIds,
        metadata: result.metadata,
      };
      const candidates = rankOpenRouterCandidates(modelId, discovery);
      const best = candidates[0];
      const matchedId = best && best.score >= 94
        ? best.modelId : undefined;
      setModelDiscoveries(current => ({
        ...current,
        [providerRef]: {
          status: 'ready',
          // OpenRouter 只提供公开元数据，不能把它的全量目录写入当前
          // Provider 的模型列表，否则 DeepSeek 等 Provider 会出现 AionLabs
          // 等无关模型。候选匹配直接使用本次 result，不依赖这里的 modelIds。
          modelIds: current[providerRef]?.modelIds,
          capabilities: {
            ...(current[providerRef]?.capabilities ?? {}),
            ...result.capabilities,
          },
          metadata: {
            ...(current[providerRef]?.metadata ?? {}),
            ...(result.metadata ?? {}),
          },
          prices: {
            ...(current[providerRef]?.prices ?? {}),
            ...(result.prices ?? {}),
          },
        },
      }));
      return {
        ...(matchedId ? { matchedId } : {}),
        ...(await summarizeRoutingProfile(matchedId)),
        candidates,
        capabilities: result.capabilities[matchedId ?? modelId] ?? [],
        metadata: result.metadata?.[matchedId ?? modelId],
        price: result.prices?.[matchedId ?? modelId],
      };
    } catch {
      return {
        candidates: [] as OpenRouterCandidate[],
        capabilities: [] as string[],
        metadata: undefined,
        price: undefined,
      };
    }
  };

  const refreshModelInfo = async (modelRef: string): Promise<void> => {
    const model = catalog?.models[modelRef];
    if (!model) return;
    setModelInfoLoading(modelRef);
    setModelInfoStatus(current => ({
      ...current,
      [modelRef]: { status: 'error', message: '正在查询 OpenRouter…' },
    }));
    setLoadError(null);
    try {
      const facts = await fetchOpenRouterFactsForModel(model.providerRef, model.modelId, true);
      const candidates = facts.candidates ?? [];
      const metadata = facts.metadata;
      const price = facts.price;
      if (!metadata && !price && facts.capabilities.length === 0) {
        if (candidates.length > 0) {
          setModelInfoStatus(current => ({
            ...current,
            [modelRef]: {
              status: 'success',
              candidates: candidates.slice(0, 5),
              message: `未自动套用模型信息，但找到 ${candidates.length} 个候选，请选择准确的 OpenRouter 模型。`,
            },
          }));
          return;
        }
        throw new Error('OpenRouter 暂未找到该 Model ID 的公开信息。');
      }
      setCatalog(current => {
        if (!current?.models[modelRef]) return current;
        const currentModel = current.models[modelRef];
        if (currentModel.modelId !== model.modelId || currentModel.providerRef !== model.providerRef) return current;
        return {
          ...current,
          models: {
            ...current.models,
            [modelRef]: {
              ...currentModel,
              ...(facts.routingNotes ? { routingNotes: facts.routingNotes } : {}),
              ...(facts.capabilities.length > 0
                ? { capabilities: facts.capabilities, capabilityState: '已自动发现' as const } : {}),
              ...(metadata?.displayName ? { displayName: metadata.displayName } : {}),
              ...(metadata?.description ? { description: metadata.description } : {}),
              ...(metadata?.publicFacts ? { publicFacts: metadata.publicFacts } : {}),
              ...(metadata?.contextLimit !== undefined ? { contextLimit: metadata.contextLimit } : {}),
              ...(price?.inputCnyPerMillion !== undefined
                ? { costInputPerMillion: price.inputCnyPerMillion }
                : metadata?.costInputPerMillion !== undefined
                  ? { costInputPerMillion: metadata.costInputPerMillion } : {}),
              ...(price?.outputCnyPerMillion !== undefined
                ? { costOutputPerMillion: price.outputCnyPerMillion }
                : metadata?.costOutputPerMillion !== undefined
                  ? { costOutputPerMillion: metadata.costOutputPerMillion } : {}),
              ...(price?.pricing ? { pricing: price.pricing }
                : metadata?.pricing ? { pricing: metadata.pricing } : {}),
            },
          },
        };
      });
      setModelInfoStatus(current => ({
        ...current,
        [modelRef]: {
          status: facts.routingError ? 'error' : 'success',
          candidates: candidates.slice(0, 5),
          message: facts.routingError ?? `模型信息已更新：${[
            facts.routingNotes ? '能力描述已更新' : '能力描述未更新',
            facts.capabilities.length > 0 ? `${facts.capabilities.length} 项能力` : '能力描述未提供',
            metadata?.description ? '已获取模型描述' : '模型描述未提供',
            metadata?.publicFacts?.highlights?.length ? `${metadata.publicFacts.highlights.length} 条模型特征` : '结构化特征未提供',
            price?.inputCnyPerMillion !== undefined || price?.outputCnyPerMillion !== undefined
              ? '价格已获取' : '价格未提供',
          ].join(' · ')}`,
        },
      }));
    } catch (error) {
      const message = (error as Error).message;
      setModelInfoStatus(current => ({
        ...current,
        [modelRef]: { status: 'error', message },
      }));
      setLoadError(`获取模型信息失败：${message}`);
    } finally {
      setModelInfoLoading(null);
    }
  };

  const applyOpenRouterCandidate = async (modelRef: string, candidateId: string): Promise<void> => {
    const model = catalog?.models[modelRef];
    const discovery = model ? modelDiscoveries[model.providerRef] : undefined;
    if (!model || !discovery) return;
    const metadata = discovery.metadata?.[candidateId];
    const price = discovery.prices?.[candidateId];
    const capabilities = discovery.capabilities?.[candidateId] ?? [];
    if (!metadata && !price && capabilities.length === 0) return;
    setModelInfoLoading(modelRef);
    const profile = await summarizeRoutingProfile(candidateId);
    setModelInfoLoading(null);
    setCatalog(current => {
      const currentModel = current?.models[modelRef];
      if (!currentModel || currentModel.modelId !== model.modelId || currentModel.providerRef !== model.providerRef) return current;
      return {
        ...current!,
        models: {
          ...current!.models,
          [modelRef]: {
            ...currentModel,
            ...(profile.routingNotes ? { routingNotes: profile.routingNotes } : {}),
            ...(capabilities.length > 0 ? { capabilities, capabilityState: '已自动发现' as const } : {}),
            ...(metadata?.displayName ? { displayName: metadata.displayName } : {}),
            ...(metadata?.description ? { description: metadata.description } : {}),
            ...(metadata?.publicFacts ? { publicFacts: metadata.publicFacts } : {}),
            ...(metadata?.contextLimit !== undefined ? { contextLimit: metadata.contextLimit } : {}),
            ...(price?.inputCnyPerMillion !== undefined ? { costInputPerMillion: price.inputCnyPerMillion }
              : metadata?.costInputPerMillion !== undefined ? { costInputPerMillion: metadata.costInputPerMillion } : {}),
            ...(price?.outputCnyPerMillion !== undefined ? { costOutputPerMillion: price.outputCnyPerMillion }
              : metadata?.costOutputPerMillion !== undefined ? { costOutputPerMillion: metadata.costOutputPerMillion } : {}),
            ...(price?.pricing ? { pricing: price.pricing } : metadata?.pricing ? { pricing: metadata.pricing } : {}),
          },
        },
      };
    });
    setModelInfoStatus(current => ({
      ...current,
      [modelRef]: {
        status: profile.routingError ? 'error' : 'success',
        message: profile.routingError ?? `已选择 OpenRouter 模型：${candidateId}，公开信息与能力描述已填入。`,
      },
    }));
  };

  const addKnownModel = async (
    providerRef: string,
    modelId: string,
    discoveredCapabilities?: string[],
  ): Promise<void> => {
    const loadingKey = `${providerRef}:${modelId}`;
    setModelAddLoading(loadingKey);
    const openRouterFacts = await fetchOpenRouterFactsForModel(providerRef, modelId);
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
        ...(openRouterFacts.capabilities ?? []),
        ...capabilitiesForModelId(modelId),
      ])].sort();
      const discoveredMetadata = modelDiscoveries[providerRef]?.metadata?.[modelId];
      const discoveredPrice = modelDiscoveries[providerRef]?.prices?.[modelId];
      const metadata = openRouterFacts.metadata ?? discoveredMetadata;
      const price = openRouterFacts.price ?? discoveredPrice;
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            ...(openRouterFacts.routingNotes ? { routingNotes: openRouterFacts.routingNotes } : {}),
            ...(metadata?.displayName ? { displayName: metadata.displayName } : {}),
            ...(metadata?.description ? { description: metadata.description } : {}),
            ...(metadata?.publicFacts ? { publicFacts: metadata.publicFacts } : {}),
            capabilities,
            capabilityState: capabilities.length > 0 ? '已从 Provider 补全' : '需要确认',
            ...(metadata?.contextLimit !== undefined ? { contextLimit: metadata.contextLimit } : {}),
            ...(price?.inputCnyPerMillion !== undefined
              ? { costInputPerMillion: price.inputCnyPerMillion } : metadata?.costInputPerMillion !== undefined
                ? { costInputPerMillion: metadata.costInputPerMillion } : {}),
            ...(price?.outputCnyPerMillion !== undefined
              ? { costOutputPerMillion: price.outputCnyPerMillion } : metadata?.costOutputPerMillion !== undefined
                ? { costOutputPerMillion: metadata.costOutputPerMillion } : {}),
            ...(price?.pricing ? { pricing: price.pricing } : metadata?.pricing ? { pricing: metadata.pricing } : {}),
          },
        },
      };
    });
    setModelAddLoading(null);
  };

  const addCustomModel = async (providerRef: string): Promise<void> => {
    const modelId = (newModelIds[providerRef] ?? '').trim();
    if (!modelId) {
      setLoadError('请输入要加入 Provider 模型目录的 Model ID。');
      return;
    }
    const loadingKey = `${providerRef}:${modelId}`;
    setModelAddLoading(loadingKey);
    const openRouterFacts = await fetchOpenRouterFactsForModel(providerRef, modelId);
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
      const discoveredMetadata = openRouterFacts.metadata ?? modelDiscoveries[providerRef]?.metadata?.[modelId];
      const discoveredPrice = openRouterFacts.price ?? modelDiscoveries[providerRef]?.prices?.[modelId];
      const capabilities = [...new Set([
        ...capabilitiesForModelId(modelId),
        ...(openRouterFacts.capabilities ?? []),
        ...(modelDiscoveries[providerRef]?.capabilities?.[modelId] ?? []),
      ])].sort();
      return {
        ...current,
        models: {
          ...current.models,
          [ref]: {
            ref,
            providerRef,
            modelId,
            ...(openRouterFacts.routingNotes ? { routingNotes: openRouterFacts.routingNotes } : {}),
            ...(discoveredMetadata?.displayName ? { displayName: discoveredMetadata.displayName } : {}),
            ...(discoveredMetadata?.description ? { description: discoveredMetadata.description } : {}),
            ...(discoveredMetadata?.publicFacts ? { publicFacts: discoveredMetadata.publicFacts } : {}),
            capabilities,
            capabilityState: capabilities.length > 0 ? '已从 Provider 补全' : '需要确认',
            ...(discoveredMetadata?.contextLimit !== undefined ? { contextLimit: discoveredMetadata.contextLimit } : {}),
            ...(discoveredPrice?.inputCnyPerMillion !== undefined
              ? { costInputPerMillion: discoveredPrice.inputCnyPerMillion }
              : discoveredMetadata?.costInputPerMillion !== undefined
                ? { costInputPerMillion: discoveredMetadata.costInputPerMillion } : {}),
            ...(discoveredPrice?.outputCnyPerMillion !== undefined
              ? { costOutputPerMillion: discoveredPrice.outputCnyPerMillion }
              : discoveredMetadata?.costOutputPerMillion !== undefined
                ? { costOutputPerMillion: discoveredMetadata.costOutputPerMillion } : {}),
            ...(discoveredPrice?.pricing ? { pricing: discoveredPrice.pricing }
              : discoveredMetadata?.pricing ? { pricing: discoveredMetadata.pricing } : {}),
          },
        },
      };
    });
    setModelAddLoading(null);
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
          metadata: result.metadata,
          prices: result.prices,
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

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer settings-workbench" onClick={event => event.stopPropagation()}>
        <header className="drawer-header settings-header">
          <div>
            <div className="settings-eyebrow">配置工作台</div>
            <h2>设置</h2>
            <p>管理 Provider、模型和智能体路由。新增模型后，公开目录会自动补全能力与价格。</p>
          </div>
          <div className="settings-header-actions">
            <span className={`activation-pill activation-pill-${activationState?.activationStatus ?? 'idle'}`}>
              {activationState?.activationStatus === 'busy' ? '运行中，暂不可激活'
                : activationState?.activationStatus === 'activating' ? '正在激活'
                  : '可热激活'}
            </span>
            <button type="button" className="ghost-button" onClick={onClose}>关闭</button>
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
                    <div className="settings-eyebrow">模型与连接</div>
                    <h3 id="models-heading">模型</h3>
                    <p>
                      先配置 Provider，再从公开目录中添加模型。Provider 默认收起，展开后可查看连接、模型列表和编辑项。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={editingDisabled}
                    onClick={() => setModelDialogOpen(true)}
                  >
                    新增模型
                  </button>
                </div>
                <div className="provider-grid">
                  {Object.values(catalog.providers).filter(provider => !provider.systemManaged).map(provider => {
                    const knownModels = buildProviderModelOptions(
                      Object.values(catalog.providers),
                      Object.values(catalog.models),
                      provider.providerRef,
                    );
                    const providerDiscovery = modelDiscoveries[provider.providerRef];
                    const discoveredModelIds = providerDiscovery?.modelIds ?? provider.modelIds;
                    const configuredModels = knownModels.filter(model => model.configured);
                    const expanded = expandedProviders.has(provider.providerRef);
                    return (
                      <article className="provider-card model-connection-card" key={provider.providerRef}>
                        <div className="provider-card-heading">
                          <div>
                            <span className="provider-kicker">模型服务</span>
                            <h4>{provider.displayName || '未命名 Provider'}</h4>
                            <span className="mono">{provider.baseUrl || '尚未填写 API URL'}</span>
                          </div>
                          <button
                            type="button"
                            className="provider-collapse-toggle"
                            aria-expanded={expanded}
                            aria-controls={`provider-details-${provider.providerRef}`}
                            aria-label={`${expanded ? '收起' : '展开'} ${provider.displayName || '模型服务'}`}
                            onClick={() => setExpandedProviders(current => {
                              const next = new Set(current);
                              if (next.has(provider.providerRef)) next.delete(provider.providerRef);
                              else next.add(provider.providerRef);
                              return next;
                            })}
                          >
                            <span>{expanded ? '收起配置' : '展开配置'}</span>
                            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
                          </button>
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
                              type="button"
                              className="text-button danger-button"
                              disabled={editingDisabled}
                              onClick={() => removeProvider(provider.providerRef)}
                            >
                              删除 Provider
                            </button>
                          </div>
                        </div>
                        <div className="provider-stat">
                          <strong>{configuredModels.length}</strong>
                          <span>个已添加模型</span>
                          <span className="provider-stat-divider">·</span>
                          <span>能力与价格自动补全</span>
                          {configuredModels.length > 0 && (
                            <span
                              className="provider-model-preview"
                              title={configuredModels.map(model => model.modelId).join('、')}
                            >
                              {configuredModels.slice(0, 3).map(model => model.modelId).join('、')}
                              {configuredModels.length > 3 ? ` 等 ${configuredModels.length} 个` : ''}
                            </span>
                          )}
                        </div>
                        {expanded && <div
                          id={`provider-details-${provider.providerRef}`}
                          className="provider-card-expanded-body"
                        >
                        <details className="provider-settings-disclosure">
                          <summary>
                            <span>连接设置</span>
                            <small>名称、API 地址和凭证</small>
                          </summary>
                          <div className="provider-fields">
                            <label className="settings-field">
                              <span>Provider 名称</span>
                              <input
                                className="text-input"
                                value={provider.displayName}
                                onChange={event => setCatalog(current => current ? {
                                  ...current,
                                  providers: {
                                    ...current.providers,
                                    [provider.providerRef]: { ...provider, displayName: event.target.value },
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
                                    [provider.providerRef]: { ...provider, apiKey: event.target.value },
                                  },
                                } : current)}
                                autoComplete="new-password"
                                disabled={editingDisabled}
                              />
                              <small>新的 Key 先保留在草稿中，点击“保存并激活”后统一替换。</small>
                            </label>
                          </div>
                        </details>
                        <div className="provider-discovery">
                          <button
                            type="button"
                            className="ghost-button"
                            aria-label="重新发现模型"
                            disabled={editingDisabled
                              || !provider.baseUrl.trim()
                              || modelDiscoveries[provider.providerRef]?.status === 'loading'}
                            onClick={() => { void discoverModels(provider); }}
                          >
                            {modelDiscoveries[provider.providerRef]?.status === 'loading'
                              ? '正在获取模型列表…'
                              : '刷新模型目录'}
                          </button>
                          {modelDiscoveries[provider.providerRef]?.status === 'error' && (
                            <p className="provider-discovery-message provider-discovery-error">
                              {modelDiscoveries[provider.providerRef]?.message}
                            </p>
                          )}
                          {discoveredModelIds.length > 0 && (
                            <div className="provider-discovery-list discovered-models-list">
                              <div className="model-list-heading">
                                <span className="fact-label">可添加模型</span>
                                <span className="model-list-count">
                                  {discoveredModelIds.filter(modelId => !Object.values(catalog.models).some(model => (
                                    model.providerRef === provider.providerRef && model.modelId === modelId
                                  ))).length} 个未配置
                                </span>
                              </div>
                              {discoveredModelIds.every(modelId => Object.values(catalog.models).some(model => (
                                model.providerRef === provider.providerRef && model.modelId === modelId
                              ))) && (
                                <p className="model-empty-hint">目录中的模型已全部添加。</p>
                              )}
                              {discoveredModelIds.filter(modelId => !Object.values(catalog.models).some(model => (
                                model.providerRef === provider.providerRef && model.modelId === modelId
                              ))).map(modelId => {
                                const discoveredCapabilities =
                                  modelDiscoveries[provider.providerRef]?.capabilities?.[modelId] ?? [];
                                return (
                                <div className="provider-model-line discovered-model-row" key={modelId}>
                                    <span className="model-primary-fact">
                                      <strong>{modelDiscoveries[provider.providerRef]?.metadata?.[modelId]?.displayName ?? modelId}</strong>
                                      <small className="mono">{modelId}</small>
                                      <small>{modelDiscoveries[provider.providerRef]?.metadata?.[modelId]?.description ?? '公开目录已发现，可添加后查看模型事实。'}</small>
                                    </span>
                                    <span className="model-fact-summary">
                                      <span className="model-price-inline">
                                        {modelDiscoveries[provider.providerRef]?.prices?.[modelId]?.inputCnyPerMillion !== undefined
                                          && modelDiscoveries[provider.providerRef]?.prices?.[modelId]?.outputCnyPerMillion !== undefined
                                          ? `¥${modelDiscoveries[provider.providerRef]?.prices?.[modelId]?.inputCnyPerMillion} / ¥${modelDiscoveries[provider.providerRef]?.prices?.[modelId]?.outputCnyPerMillion}`
                                          : '价格待补充'}
                                      </span>
                                    </span>
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={editingDisabled || modelAddLoading === `${provider.providerRef}:${modelId}`}
                                      onClick={() => addKnownModel(
                                        provider.providerRef,
                                        modelId,
                                        discoveredCapabilities,
                                      )}
                                    >
                                      {modelAddLoading === `${provider.providerRef}:${modelId}` ? '获取信息中…' : '新增模型'}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="provider-model-list configured-models-list">
                            <div className="model-list-heading">
                              <span className="fact-label">已配置模型</span>
                              <span className="model-list-count">{configuredModels.length} 个已添加</span>
                            </div>
                            {configuredModels.length === 0 && (
                              <p className="model-empty-hint">还没有添加模型。请从上面的公开目录选择，或输入自定义 Model ID。</p>
                            )}
                            {configuredModels.map(option => (
                              <div className="model-catalog-item" key={option.modelId}>
                                <div className="provider-model-line">
                                  <span className="model-primary-fact">
                                    <strong>{catalog.models[option.modelRef ?? '']?.displayName ?? option.modelId}</strong>
                                    <small className="mono">{option.modelId}</small>
                                    {(catalog.models[option.modelRef ?? '']?.routingNotes?.summary || catalog.models[option.modelRef ?? '']?.description) && (
                                      <small>{catalog.models[option.modelRef ?? '']?.routingNotes?.summary || catalog.models[option.modelRef ?? '']?.description}</small>
                                    )}
                                  </span>

                                  {option.configured && option.modelRef && (
                                    <span className="model-price-inline">
                                      {catalog.models[option.modelRef]?.costInputPerMillion !== undefined
                                        && catalog.models[option.modelRef]?.costOutputPerMillion !== undefined
                                        ? `¥${catalog.models[option.modelRef]?.costInputPerMillion} / ¥${catalog.models[option.modelRef]?.costOutputPerMillion}`
                                        : '价格待补充'}
                                    </span>
                                  )}
                                  {option.configured && option.modelRef && (
                                    <span className="model-context-inline">
                                      {catalog.models[option.modelRef]?.contextLimit
                                        ? `${(catalog.models[option.modelRef]!.contextLimit! / 1000).toLocaleString()}K 上下文`
                                        : '上下文待确认'}
                                    </span>
                                  )}
                                  {option.configured && option.modelRef && (
                                    <label className="model-enabled-toggle" title="是否允许智能体使用此模型">
                                      <input
                                        type="checkbox"
                                        checked={catalog.models[option.modelRef]?.enabled !== false}
                                        disabled={editingDisabled}
                                        aria-label={`启用模型 ${option.modelId}`}
                                        onChange={event => setCatalog(current => {
                                          if (!current) return current;
                                          const model = current.models[option.modelRef!];
                                          return model ? {
                                            ...current,
                                            models: {
                                              ...current.models,
                                              [option.modelRef!]: { ...model, enabled: event.target.checked },
                                            },
                                          } : current;
                                        })}
                                      />
                                      <span>{catalog.models[option.modelRef]?.enabled !== false ? '启用' : '停用'}</span>
                                    </label>
                                  )}
                                  {option.configured && option.modelRef && (
                                    <button
                                      type="button"
                                      className="text-button model-edit-button"
                                      disabled={editingDisabled}
                                      onClick={() => setModelEditRef(current => current === option.modelRef ? null : option.modelRef)}
                                    >
                                      {modelEditRef === option.modelRef ? '收起' : '编辑'}
                                    </button>
                                  )}
                                  {option.configured ? (
                                    <button
                                      type="button"
                                      className="text-button danger-button"
                                      disabled={editingDisabled}
                                      onClick={() => removeProviderModel(provider.providerRef, option.modelId)}
                                    >
                                      移除
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={editingDisabled}
                                      onClick={() => addKnownModel(provider.providerRef, option.modelId)}
                                    >
                                      新增模型
                                    </button>
                                  )}
                                </div>
                                {option.configured && option.modelRef && modelEditRef === option.modelRef && (
                                  <div className="model-edit-panel">
                                    <div className="model-edit-header">
                                      <div>
                                        <strong>编辑模型</strong>
                                        <span>获取公开能力资料，或修改模型连接参数和价格。</span>
                                      </div>
                                      <div className="model-edit-header-actions">
                                        <button
                                          type="button"
                                          className="ghost-button"
                                          disabled={loading || executorLoading || modelInfoLoading === option.modelRef}
                                          onClick={() => { void refreshModelInfo(option.modelRef!); }}
                                        >
                                          {modelInfoLoading === option.modelRef ? '获取中…' : '获取模型信息'}
                                        </button>
                                        <span className="state-badge">
                                          {catalog.models[option.modelRef]?.pricing?.source === 'user'
                                            ? '价格已覆盖'
                                            : catalog.models[option.modelRef]?.pricing?.source === 'openrouter'
                                              ? '价格已自动获取'
                                              : '价格待补充'}
                                        </span>
                                      </div>
                                    </div>
                                    {modelInfoStatus[option.modelRef] && (
                                      <>
                                        <p className={`model-info-status model-info-status-${modelInfoStatus[option.modelRef]!.status}`} role="status">
                                          {modelInfoStatus[option.modelRef]!.message}
                                        </p>
                                        {(modelInfoStatus[option.modelRef]!.candidates?.length ?? 0) > 0 && (
                                          <div className="openrouter-candidate-list" role="list" aria-label="OpenRouter 候选模型">
                                            {modelInfoStatus[option.modelRef]!.candidates!.map(candidate => (
                                              <div className="openrouter-candidate" key={candidate.modelId} role="listitem">
                                                <div>
                                                  <strong>{candidate.displayName ?? candidate.modelId}</strong>
                                                  <span className="mono">{candidate.modelId}</span>
                                                  <small>{candidate.match === 'token-overlap'
                                                    ? `按名称相似度匹配 · ${candidate.score} 分`
                                                    : '高置信度匹配'}</small>
                                                </div>
                                                <button
                                                  type="button"
                                                  className="text-button"
                                                  disabled={loading || executorLoading}
                                                  onClick={() => { void applyOpenRouterCandidate(option.modelRef!, candidate.modelId); }}
                                                >
                                                  选择此模型
                                                </button>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </>
                                    )}
                                    {catalog.models[option.modelRef]?.routingNotes && (
                                      <ModelCapabilityDetails notes={catalog.models[option.modelRef]!.routingNotes!} />
                                    )}
                                    <label className="settings-field model-id-editor">
                                      <span>Model ID</span>
                                      <input
                                        className="text-input mono"
                                        value={catalog.models[option.modelRef]?.modelId ?? option.modelId}
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelId(option.modelRef!, event.target.value)}
                                      />
                                    </label>
                                    {(catalog.models[option.modelRef]?.description
                                      || catalog.models[option.modelRef]?.displayName
                                      || catalog.models[option.modelRef]?.publicFacts) && (
                                      <div className="model-public-facts">
                                        <div className="model-public-facts-heading">
                                          <span className="fact-label">模型特点与公开参数</span>
                                          <span className="model-fact-source">任务匹配的公开依据</span>
                                        </div>
                                        {catalog.models[option.modelRef]?.displayName && (
                                          <strong>{catalog.models[option.modelRef]?.displayName}</strong>
                                        )}
                                        {catalog.models[option.modelRef]?.description && (
                                          <p>{catalog.models[option.modelRef]?.description}</p>
                                        )}
                                        {catalog.models[option.modelRef]?.publicFacts?.highlights?.length ? (
                                          <div className="model-public-highlights">
                                            {catalog.models[option.modelRef]!.publicFacts!.highlights.map(highlight => (
                                              <span key={highlight}>{highlight}</span>
                                            ))}
                                          </div>
                                        ) : null}
                                        {catalog.models[option.modelRef]?.publicFacts && (
                                          <div className="model-public-facts-grid">
                                            {catalog.models[option.modelRef]!.publicFacts!.inputModalities.length > 0 && (
                                              <div>
                                                <span>输入</span>
                                                <strong>{catalog.models[option.modelRef]!.publicFacts!.inputModalities.join(' · ')}</strong>
                                              </div>
                                            )}
                                            {catalog.models[option.modelRef]!.publicFacts!.outputModalities.length > 0 && (
                                              <div>
                                                <span>输出</span>
                                                <strong>{catalog.models[option.modelRef]!.publicFacts!.outputModalities.join(' · ')}</strong>
                                              </div>
                                            )}
                                            {catalog.models[option.modelRef]!.publicFacts!.supportedParameters.length > 0 && (
                                              <div>
                                                <span>支持参数</span>
                                                <strong>{catalog.models[option.modelRef]!.publicFacts!.supportedParameters.join(' · ')}</strong>
                                              </div>
                                            )}
                                            {catalog.models[option.modelRef]!.publicFacts!.reasoning && (
                                              <div>
                                                <span>推理配置</span>
                                                <strong>
                                                  {catalog.models[option.modelRef]!.publicFacts!.reasoning!.mandatory ? '必须推理' : '可选推理'}
                                                  {catalog.models[option.modelRef]!.publicFacts!.reasoning!.supportedEfforts?.length
                                                    ? ` · ${catalog.models[option.modelRef]!.publicFacts!.reasoning!.supportedEfforts!.join(' / ')}` : ''}
                                                </strong>
                                              </div>
                                            )}
                                            {catalog.models[option.modelRef]!.publicFacts!.maxCompletionTokens && (
                                              <div>
                                                <span>最大输出</span>
                                                <strong>{(catalog.models[option.modelRef]!.publicFacts!.maxCompletionTokens! / 1000).toLocaleString()}K tokens</strong>
                                              </div>
                                            )}
                                            {Object.entries(catalog.models[option.modelRef]!.publicFacts!.benchmarks ?? {}).length > 0 && (
                                              <div>
                                                <span>公开基准</span>
                                                <strong>{Object.entries(catalog.models[option.modelRef]!.publicFacts!.benchmarks!).map(([name, value]) => `${name} ${value}`).join(' · ')}</strong>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    <div className="model-price-editor">
                                    <label className="settings-field">
                                      <span>上下文长度</span>
                                      <input
                                        className="text-input"
                                        type="number"
                                        min="1024"
                                        step="1"
                                        value={catalog.models[option.modelRef]?.contextLimit ?? ''}
                                        placeholder="自动"
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelNumber(option.modelRef!, 'contextLimit', event.target.value)}
                                      />
                                    </label>
                                    <label className="settings-field">
                                      <span>推理等级</span>
                                      <select
                                        className="text-input"
                                        value={catalog.models[option.modelRef]?.reasoning ?? ''}
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelString(option.modelRef!, 'reasoning', event.target.value)}
                                      >
                                        <option value="">自动</option><option value="disabled">关闭</option>
                                        <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
                                      </select>
                                    </label>
                                    <label className="settings-field">
                                      <span>质量等级</span>
                                      <select
                                        className="text-input"
                                        value={catalog.models[option.modelRef]?.qualityTier ?? ''}
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelString(option.modelRef!, 'qualityTier', event.target.value)}
                                      >
                                        <option value="">自动</option><option value="low">低</option>
                                        <option value="medium">中</option><option value="high">高</option>
                                      </select>
                                    </label>
                                    <label className="settings-field">
                                      <span>速度等级</span>
                                      <select
                                        className="text-input"
                                        value={catalog.models[option.modelRef]?.latencyTier ?? ''}
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelString(option.modelRef!, 'latencyTier', event.target.value)}
                                      >
                                        <option value="">自动</option><option value="low">慢</option>
                                        <option value="medium">中</option><option value="high">快</option>
                                      </select>
                                    </label>
                                    <label className="settings-field">
                                      <span>成本等级</span>
                                      <select
                                        className="text-input"
                                        value={catalog.models[option.modelRef]?.costTier ?? ''}
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelString(option.modelRef!, 'costTier', event.target.value)}
                                      >
                                        <option value="">自动</option><option value="low">低</option>
                                        <option value="medium">中</option><option value="high">高</option>
                                      </select>
                                    </label>
                                    <label className="settings-field">
                                      <span>输入价格（CNY / 1M tokens）</span>
                                      <input
                                        className="text-input"
                                        type="number"
                                        min="0"
                                        step="any"
                                        inputMode="decimal"
                                        value={catalog.models[option.modelRef]?.costInputPerMillion ?? ''}
                                        placeholder="未配置"
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelPrice(
                                          option.modelRef!,
                                          'costInputPerMillion',
                                          event.target.value,
                                        )}
                                      />
                                    </label>
                                    <label className="settings-field">
                                      <span>输出价格（CNY / 1M tokens）</span>
                                      <input
                                        className="text-input"
                                        type="number"
                                        min="0"
                                        step="any"
                                        inputMode="decimal"
                                        value={catalog.models[option.modelRef]?.costOutputPerMillion ?? ''}
                                        placeholder="未配置"
                                        disabled={loading || executorLoading}
                                        onChange={event => updateModelPrice(
                                          option.modelRef!,
                                          'costOutputPerMillion',
                                          event.target.value,
                                        )}
                                      />
                                    </label>
                                    <span className="fact-label">
                                      价格来源：{catalog.models[option.modelRef]?.pricing?.source === 'user'
                                        ? '用户覆盖' : catalog.models[option.modelRef]?.pricing?.source === 'openrouter'
                                          ? 'OpenRouter 自动获取' : '待补充'}
                                    </span>
                                    {catalog.models[option.modelRef]?.pricing?.source === 'user' && (
                                      <button
                                        type="button"
                                        className="text-button"
                                        disabled={loading || executorLoading}
                                        onClick={() => setCatalog(current => {
                                          if (!current) return current;
                                          const model = current.models[option.modelRef!];
                                          if (!model?.pricing?.catalogModelId) return current;
                                          const discovered = modelDiscoveries[provider.providerRef]?.prices?.[model.modelId];
                                          const pricing = discovered?.pricing ?? model.pricing;
                                          if (pricing.source !== 'openrouter') return current;
                                          const inputCny = discovered?.inputCnyPerMillion
                                            ?? (pricing.usdInputPerToken !== undefined
                                              ? pricing.usdInputPerToken * 1_000_000 * 7 : undefined);
                                          const outputCny = discovered?.outputCnyPerMillion
                                            ?? (pricing.usdOutputPerToken !== undefined
                                              ? pricing.usdOutputPerToken * 1_000_000 * 7 : undefined);
                                          return {
                                            ...current,
                                            models: {
                                              ...current.models,
                                              [option.modelRef!]: {
                                                ...model,
                                                ...(inputCny !== undefined ? { costInputPerMillion: inputCny } : {}),
                                                ...(outputCny !== undefined ? { costOutputPerMillion: outputCny } : {}),
                                                pricing,
                                              },
                                            },
                                          };
                                        })}
                                      >
                                        恢复自动价格
                                      </button>
                                    )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                        </div>
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
                              type="button"
                              className="ghost-button"
                              disabled={editingDisabled || modelAddLoading === `${provider.providerRef}:${newModelIds[provider.providerRef] ?? ''}`}
                              onClick={() => addCustomModel(provider.providerRef)}
                            >
                              {modelAddLoading === `${provider.providerRef}:${newModelIds[provider.providerRef] ?? ''}` ? '获取信息中…' : '新增模型'}
                            </button>
                        </div>
                        </div>}
                      </article>
                    );
                  })}
                </div>
                {Object.values(catalog.providers).some(provider => provider.systemManaged) && (
                  <p className="settings-help-text">系统内置模型由 MetaWork 管理，无需在此配置。</p>
                )}
              </section>

              <section className="settings-section agents-section" aria-labelledby="agents-heading">
                <div className="section-heading">
                  <div>
                    <div className="settings-eyebrow">智能体与路由</div>
                    <h3 id="agents-heading">智能体</h3>
                    <p>每个智能体可以单独选择模型、路由方式和能力配置。</p>
                  </div>
                  <button type="button" className="primary-button" disabled={editingDisabled}
                    onClick={() => { void openExecutorEditor('create'); }}>新增智能体</button>
                </div>
                {executorView?.executors.length === 0 && <p role="status">尚无智能体。新增并启用智能体后才能开始新工作。</p>}
                {executorView && executorView.executors.length > 0 && executorView.executors.every(agent => !agent.enabled)
                  && <p role="status">全部智能体已停用，请先启用至少一名智能体。</p>}
                {agentReadiness.length > 0 && (
                  <div className="agent-readiness-settings">
                    {agentReadiness.filter(agent => agent.required).map(agent => (
                      <div className={`agent-readiness-settings-card agent-readiness-settings-${agent.status}`} key={agent.agentId}>
                        <div>
                          <strong>
                            {agent.displayName} {agent.status === 'installed' ? '已就绪' : '未就绪'}
                          </strong>
                          <p>
                            {agent.status === 'installed'
                              ? '此执行工具已安装，可供多个智能体共用。'
                              : '当前启用的智能体需要此工具。请先安装，或在空闲时停用使用它的智能体。'}
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
                    {agentReadiness.filter(agent => !agent.required).map(agent => (
                      <div className="agent-readiness-settings-card agent-readiness-settings-optional" key={agent.agentId}>
                        <div>
                          <strong>
                            {agent.displayName} {agent.status === 'installed' ? '已安装' : agent.status === 'checking' ? '正在检测' : agent.status === 'broken' ? '暂不可用' : '未检测到 · 可选工具'}
                          </strong>
                          <p>
                            {agent.status === 'installed'
                              ? '执行工具已安装，目前没有启用的智能体需要它。'
                              : agent.status === 'checking' ? '正在检查执行工具是否可用…' : '当前没有启用的智能体需要此工具，不影响其他智能体的配置保存。'}
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
                <p className="routing-section-note">智能体按“职责 → 模型 → 能力画像”组织。默认收起配置详情，先看整体状态，再进入单个智能体编辑。</p>
                <div className="routing-stack">
                  {Object.entries(draft)
                    .sort(([left], [right]) => left === 'planner' ? -1 : right === 'planner' ? 1 : left.localeCompare(right))
                    .map(([ref, entry]) => {
                    const agentFacts = facts[ref];
                    if (!agentFacts) return null;
                    const managed = executorView?.executors.find(agent => agent.agentClassRef === ref);
                    const expanded = expandedAgents.has(ref);
                    return (
                      <div key={ref}>
                        <div className={`agent-summary-row ${agentFacts.kind === 'planner' ? 'agent-summary-planner' : ''}`}>
                          <button
                            type="button"
                            className="agent-summary-toggle"
                            aria-expanded={expanded}
                            aria-controls={`agent-editor-${ref}`}
                            onClick={() => setExpandedAgents(current => {
                              const next = new Set(current);
                              if (next.has(ref)) next.delete(ref); else next.add(ref);
                              return next;
                            })}
                          >
                            <span className="agent-summary-icon">{agentFacts.kind === 'planner' ? 'P' : 'A'}</span>
                            <span className="agent-summary-title">
                              <strong>{entry.displayName || agentFacts.displayName}</strong>
                              <small>{agentFacts.kind === 'planner' ? 'Planner · 复杂意图理解与 DAG 编排' : 'Executor · 具体任务执行'}</small>
                            </span>
                            <span className="agent-summary-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
                          </button>
                          <div className="agent-summary-meta">
                            <span className={`state-badge ${entry.enabled === false ? 'state-badge-warning' : ''}`}>
                              {entry.enabled === false ? '已停用' : '已启用'}
                            </span>
                            <span className="agent-summary-model">
                              {entry.modelRef && catalog.models[entry.modelRef]?.modelId
                                ? catalog.models[entry.modelRef]?.modelId
                                : entry.mode === 'auto' ? '自动选择模型' : '未选择模型'}
                            </span>
                          </div>
                          <p className="agent-summary-responsibility">
                            {entry.responsibility || (agentFacts.kind === 'planner' ? '理解复杂用户意图并拆解可执行 DAG' : '尚未填写职责')}
                          </p>
                        </div>
                        {expanded && <>
                        {agentFacts.kind === 'planner' ? (
                          <p className="routing-section-note planner-agent-note">
                            规划智能体负责理解复杂意图、拆解 DAG、选择执行智能体并编排验收；模型事实来自当前模型目录。
                          </p>
                        ) : (
                          <div className="executor-management-actions">
                            <span>{managed?.enabled === false ? '已停用' : '已启用'}</span>
                            <button type="button" className="ghost-button" disabled={editingDisabled || !managed?.tool}
                              onClick={() => { void openExecutorEditor('update', ref); }}>编辑智能体</button>
                            <button type="button" className="ghost-button" disabled={editingDisabled || !managed}
                              onClick={() => { void openExecutorEditor(managed?.enabled ? 'disable' : 'enable', ref); }}>
                              {managed?.enabled ? '停用' : '启用'}
                            </button>
                            <button type="button" className="ghost-button" disabled={editingDisabled || !managed}
                              onClick={() => { void openExecutorEditor('remove', ref); }}>删除</button>
                          </div>
                        )}
                        <fieldset
                          id={`agent-editor-${ref}`}
                          disabled={editingDisabled}
                          className="executor-editor-fields"
                        >
                      <AgentClassConfig
                        key={ref}
                        facts={agentFacts}
                        draft={entry}
                        models={Object.values(catalog.models)}
                        providers={Object.values(catalog.providers)}
                        http={http}
                        onSuggestResponsibility={() => { void suggestResponsibility(ref); }}
                        responsibilityFeedback={responsibilityFeedback[ref]}
                        onChange={next => {
                          const current = latestResponsibilityContext.current;
                          if (current.draft) latestResponsibilityContext.current = { ...current, draft: { ...current.draft, [ref]: next } };
                          setDraft(current => current ? { ...current, [ref]: next } : current);

                        }}
                      />
                        </fieldset>
                        </>}
                      </div>
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
                  <SpanRoutingSettings
                    draft={spanDraft}
                    credentialConfigured={spanCredentialConfigured}
                    editingDisabled={editingDisabled}
                    onChange={setSpanDraft}
                  />
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
              所有修改先保留在草稿中。「保存并激活」会统一应用连接与 Key、模型、智能体、决策模型和运行时策略。
            </div>
            <div className="settings-footer-actions">
              <button type="button" className="ghost-button" onClick={onClose}>取消</button>
              <button
                type="button"
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
        {executorEditor && executorView && http && <ExecutorEditorDialog
          key={`${executorEditor.operation}:${executorEditor.agentClassRef ?? 'new'}`}
          http={http} view={executorView} {...executorEditor}
          config={executorEditorConfig}
          disabled={editingDisabled}
          onClose={() => setExecutorEditor(null)}
          onSaved={executorSaved}
          onRemoved={executorRemoved}
          onEnabled={executorEnabled}
        />}
      </div>
    </div>
  );
}
