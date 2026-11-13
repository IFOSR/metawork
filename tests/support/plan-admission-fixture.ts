import type { ControlConfigurationView, PlannerConfigurationView } from '../../src/configuration/index.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import type { PlanAdmissionRequest, PlanAdmissionSnapshot } from '../../src/execution/plan-admission-policy.js';

export const configurationRevision = 'revision-test';

export const plannerConfiguration: PlannerConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:planner-test',
  models: [
    {
      id: 'codex-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    },
    {
      id: 'pi-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'medium',
      region: 'international',
    },
  ],
  routingCatalog: {
    version: 2,
    configurationRevision,
    capabilities: [
      {
        id: 'current-web-research',
        deliveryContract: 'Research public web sources.',
      },
      {
        id: 'workspace-engineering',
        deliveryContract: 'Modify and verify workspace files.',
      },
    ],
    agentClasses: [
      {
        id: 'pi-engineering-fixture',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['workspace implementation'],
        avoidUseCases: [],
        affordances: ['workspace-command-validation', 'workspace-read-write'],
        modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
      },
      {
        id: 'pi-agent',
        routingCapabilities: ['current-web-research', 'workspace-engineering'],
        primaryUseCases: ['research and implementation'],
        avoidUseCases: [],
        affordances: [
          'public-web-fetch',
          'public-web-search',
          'source-citation',
          'workspace-command-validation',
          'workspace-read-write',
        ],
        modelPolicy: { mode: 'fixed', modelRef: 'pi-model' },
      },
    ],
  },
};

export const kernelConfiguration: ControlConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:kernel-test',
  agentClasses: {
    'pi-engineering-fixture': {
      kind: 'executor',
      harnessRef: 'codex-harness',
      driverId: 'pi-cli',
      modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
    'pi-agent': {
      kind: 'executor',
      harnessRef: 'pi-harness',
      driverId: 'pi-cli',
      modelPolicy: { mode: 'fixed', modelRef: 'pi-model' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['current-web-research', 'workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: false,
    },
  },
  models: {
    'codex-model': {
      providerRef: 'openai',
      modelId: 'gpt-5.6-sol',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      enabled: true,
    },
    'pi-model': {
      providerRef: 'anthropic',
      modelId: 'pi-model-id',
      capabilities: ['coding', 'tools'],
      reasoning: 'medium',
      enabled: true,
    },
  },
  permissionProfiles: {
    'workspace-default': {
      profileId: 'workspace-engineering',
      version: 1,
      parameters: {},
    },
  },
  runtimePolicy: {
    maxConcurrentAttempts: 4,
  },
  workspaceExecution: { fallbackMode: 'in_place' },
};

export const codexBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-engineering-fixture',
  harnessRef: 'codex-harness',
  providerRef: 'openai',
  modelRef: 'codex-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision,
};
export const piBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-agent',
  harnessRef: 'pi-harness',
  providerRef: 'anthropic',
  modelRef: 'pi-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision,
};

export const event: PlanAdmissionRequest = {
  configurationRevision,

  id: 'event_plan_1',

  occurredAt: '2026-07-20T00:00:00.000Z',
  sessionId: 'session_1',
  requestText: 'hello',
  generationId: 'generation_event_plan_1',
  proposalSource: 'initial',
  targetGraphRevision: 1,
  workspaceAdmission: {
    targetWorkspace: {
      workspaceId: 'workspace-1',
      canonicalPath: '/tmp/metawork-test-workspace',
    },
  },
  proposal: {
    id: 'plan_1',
    schemaVersion: 9,
    action: 'no_action',
    confidence: 0.9,
    reason: 'answer directly',
    clarificationQuestion: null,
    task: {
      binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null,
      includeRecentConversationContext: false, priority: null,
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: null,
    source: 'anyfusion-planner',
  },
};

export const snapshot: PlanAdmissionSnapshot = {
  tasks: [],
  runningTaskId: null,
  plannerConfiguration,
  configuration: kernelConfiguration,
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: [],
  pendingAuthorizationRequest: null,
};

