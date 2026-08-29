// Server application entrypoint. Client launchers live in src/client and never
// construct the Runtime composition below.
import { dirname, join, resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createDatabase } from '../storage/database.js';
import { TaskRepo } from '../storage/task-repo.js';
import { PreferenceRepo } from '../storage/preference-repo.js';
import { TaskSearchIndexRepo } from '../storage/task-search-index-repo.js';
import { TaskEngine } from '../task/task-engine.js';
import { MemoryEngine } from '../memory/memory-engine.js';
import { OrchestrationEngine } from '../guidance/orchestration.js';
import { ContextRecaller } from '../memory/context-recaller.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import { formatCliHelp, parseCliArgs } from '../cli/args.js';
import { runConfigurationAdmin, type ConfigurationMutationResult } from '../commands/configuration-admin.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import { AgentRuntimeRenderer } from '../configuration/agent-runtime-renderer.js';
import { ConfigurationService, type ActivateDraftResult } from '../configuration/configuration-service.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import {
  buildApplicationConfig,
  createProductionConfigurationProbe,
  createProductionRuntimeBindings,
  createProductionSecretStore,
  resolvePlannerRuntimeEnvironment,
  importLocalAgentCredentials,
  importLocalAgentCredentialsForRefs,
} from '../configuration/index.js';
import { prepareProductionSecretStore } from '../configuration/production-secret-store.js';
import { FileSecretStore } from '../configuration/file-secret-store.js';
import {
  assertSecretReference,
  type SecretReference,
  type SecretStore,
} from '../configuration/secret-store.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { AccountLayoutMigrator } from '../installation/account-layout-migrator.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { buildAccountRuntimeComposition } from '../account/account-runtime-composition.js';
import { RuntimeRegistry } from '../account/runtime-registry.js';
import { ConversationRegistry } from '../session/conversation-registry.js';
import { createNotificationService } from '../notifications/feishu.js';
import { nanoid } from 'nanoid';
import { MetaclawGatewayServer } from '../gateway/server.js';
import { resolveGatewaySocketPath } from '../gateway/gateway-paths.js';
import { MarkdownPreviewServer } from '../integrations/markdown-preview.js';
import { FeishuRuntimeManager } from '../gateway/feishu-runtime.js';
import { FeishuGatewayAdapter } from '../gateway/feishu-gateway-adapter.js';
import { FeishuConversationRouting } from '../gateway/feishu-conversation-routing.js';
import { FeishuGatewaySessionPort } from '../gateway/feishu-gateway-session-port.js';
import { ClientGateway } from '../gateway/client-gateway.js';
import { BindingConversationResolver } from '../gateway/conversation-resolver.js';
import { ConversationBindingRepository } from '../session/conversation-binding-repository.js';
import { FileEventJournal } from '../gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../gateway/gateway-subscriptions.js';
import { ConversationGatewayRuntime } from '../gateway/conversation-gateway-runtime.js';
import { FileCommandAdmissionStore } from '../gateway/command-admission-store.js';
import { WebGatewayAdapter } from '../management/web-gateway-adapter.js';
import { formatGatewayDoctorChecks, runGatewayDoctor } from '../gateway/doctor.js';
import { ConversationSession } from '../session/conversation-session.js';
import { FileConversationStore } from '../session/file-conversation-store.js';
import { FileWorkspaceCatalogStore } from '../storage/file-workspace-catalog-store.js';
import {
  CONVERSATION_FORMAT_VERSION,
  type ConversationRecord,
} from '../session/conversation-store.js';
import {
  ConversationWorkspaceService,
  isAuthenticatedWorkspacePrincipalId,
} from '../workspace/conversation-workspace-service.js';
import { WorkspaceConversationMigrator } from '../workspace/workspace-conversation-migrator.js';
import { WorkspaceDirectoryService } from '../workspace/workspace-directory-service.js';
import { WorkspaceGatewayRuntime } from '../gateway/workspace-gateway-runtime.js';
import { workspaceEventStreamId } from '../gateway/workspace-event-stream.js';
import { clientConnectionEventStreamId } from '../gateway/client-connection-event-stream.js';
import { resolveServerWebPort } from './server-web-port.js';
import type { ConversationActivityProjection } from '../workspace/conversation-activity-projector.js';
import { SessionPersistenceService } from '../session/session-persistence-service.js';
import { SessionPresentationService } from '../session/session-presentation-service.js';
import { SessionStateRepo } from '../storage/session-state-repo.js';
import { PlannerProposalRepo } from '../storage/planner-proposal-repo.js';
import { InteractionTraceStream } from '../session/interaction-trace-stream.js';
import { PlanningContextBuilder } from '../planning/planning-context-builder.js';
import { CommandReadServices } from '../commands/command-read-services.js';
import { createDefaultCommandCatalog } from '../commands/command-tree.js';
import { ConversationInputMailbox } from '../session/conversation-input-mailbox.js';
import { PlannerHostBridge } from '../tui-bridge/planner-host-bridge.js';
import { PlannerProcessSupervisor } from '../planning/planner-process-supervisor.js';
import { buildStagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import { buildPlannerInputProfile } from '../planning/planner-input-profile.js';
import { buildPlannerConfigurationView } from '../configuration/projections.js';
import { AutoModelResolver } from '../routing/auto-model-resolver.js';
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import {
  acquireInstanceLock,
  isInstanceRunning,
  removeInstanceLockOnExit,
  stopInstanceForRestart,
  type InstanceLock,
} from '../management/lock.js';
import { formatWebAccessTokenLine } from '../management/token.js';
import { ManagementServer, type ConfigQuery, type ExecutionQuery } from '../management/server.js';
import { ArtifactPreviewService } from '../management/artifact-preview-service.js';
import { TaskArtifactRepo } from '../storage/task-artifact-repo.js';
import { ExecutionProjector } from '../management/execution-projector.js';
import { WorkGraphPresentationProjector } from '../management/work-graph-presentation-projector.js';
import { WebAuthService } from '../management/web-auth.js';
import { WebLaunchContextService } from '../management/web-launch-context.js';
import { resolveLoginCredentials } from '../management/login-credentials.js';
import { FileConversationPresentationStore } from '../storage/file-conversation-presentation-store.js';
import { FileAttachmentStore } from '../storage/file-attachment-store.js';
import { WebSessionCatalog } from '../management/web-session-catalog.js';
import { WebGatewaySessionRuntime } from '../management/web-gateway-session-runtime.js';
import type { ManagementWebSessionRuntime } from '../management/web-session-runtime-types.js';
import {
  normalizeExecutionPresentation,
} from '../management/execution-presentation-normalizer.js';
import type { ConversationTurn } from '../management/web-session-types.js';
import { buildCanonicalSubtaskIdentityMap } from '../work-graph/index.js';
import { ensureActiveConfigurationRevision } from '../storage/active-configuration-revision.js';
import {
  ConfigurationActivationGate,
} from '../configuration/configuration-activation-gate.js';
import {
  ConfigurationRuntimeCoordinator,
} from '../configuration/configuration-runtime-coordinator.js';
import { ConfigurationCompletionService } from '../configuration/configuration-completion-service.js';
import { PUBLIC_PROVIDER_PRESETS } from '../configuration/public-provider-catalog.js';
import { ConfigurationRevisionRepo } from '../storage/configuration-revision-repo.js';
import {
  classifyServerReadiness,
  writeEndpointManifest,
  readEndpointManifest,
  removeEndpointManifest,
} from '../server/server-endpoint-manifest.js';
import { readReleaseIdentity } from '../installation/release-identity.js';
import {
  createServerApplication,
} from './server-application.js';
import { createServerComposition } from './server-composition-contract.js';

function toMutationResult(result: ActivateDraftResult): ConfigurationMutationResult {
  if (result.ok) return { ok: true, revisionId: result.snapshot.revisionId };
  return { ok: false, code: result.code, activeRevisionId: result.activeRevisionId };
}

const LOCAL_AGENT_PROVIDER_REFS = ['code-cli', 'kimi', 'deepseek'] as const;

function localAgentCredentialSources() {
  return {
    codexHomes: [join(homedir(), '.config', 'anyfusion', 'codex')],
    piHomes: [join(homedir(), '.config', 'anyfusion', 'pi-home', '.pi')],
    plannerHomes: [join(homedir(), '.config', 'anyfusion', 'planner')],
  };
}

async function preheatLocalAgentCredentials(secretStore: SecretStore): Promise<void> {
  const scheme = secretStore instanceof FileSecretStore ? 'file-secret' : 'keychain';
  const providers: Record<string, SecretReference> = Object.fromEntries(
    LOCAL_AGENT_PROVIDER_REFS.map(providerRef => [
      providerRef,
      `${scheme}:anyfusion/providers/${providerRef}` as SecretReference,
    ]),
  );
  await importLocalAgentCredentialsForRefs({
    ...localAgentCredentialSources(),
    providers,
    secretStore,
  });
}

async function activateConfiguration(
  service: ConfigurationService,
  config: AnyFusionConfigurationV2,
  baseRevisionId: string,
): Promise<ConfigurationMutationResult> {
  const draft = service.createDraft(config, baseRevisionId);
  const validation = service.validateDraft(draft.revisionId);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'validation_failed',
      activeRevisionId: baseRevisionId,
      issues: validation.issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`),
    };
  }
  service.compileDraft(draft.revisionId);
  const probe = await service.probeDraft(draft.revisionId);
  if (!probe.ok) {
    return {
      ok: false,
      code: 'probe_failed',
      activeRevisionId: baseRevisionId,
      issues: probe.issues,
    };
  }
  return toMutationResult(await service.activateDraft(draft.revisionId, baseRevisionId, 'activation'));
}

async function startWebMode(options: {
  port: number;
  noOpen: boolean;
  runningRevisionId: string;
  sessionRuntime: ManagementWebSessionRuntime;
  executionQuery: ExecutionQuery;
  configQuery: ConfigQuery;
  configurationRuntime?: {
    getState(): ReturnType<ConfigurationRuntimeCoordinator['getState']>;
    subscribe(listener: (event: unknown) => void): () => void;
  };
  attachmentStore?: FileAttachmentStore;
  artifactQuery: ArtifactPreviewService;
  webAuth: WebAuthService;
}): Promise<ManagementServer> {
  const loginCredentials = resolveLoginCredentials(process.env);
  if (loginCredentials.generated && loginCredentials.password) {
    process.stdout.write(
      `MetaWork Web 登录账号：${loginCredentials.username} / ${loginCredentials.password}\n`,
    );
  }
  const webDistDir = process.env.ANYFUSION_WEB_DIST
    ? resolve(process.env.ANYFUSION_WEB_DIST)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  const managementServer = new ManagementServer({
    port: options.port,
    webDistDir,
    token: options.webAuth.manualAccessToken,
    webAuth: options.webAuth,
    runningRevisionId: options.runningRevisionId,
    sessionRuntime: options.sessionRuntime,
    executionQuery: options.executionQuery,
    configQuery: options.configQuery,
    configurationRuntime: options.configurationRuntime,
    loginCredentials,
    attachmentStore: options.attachmentStore,
    artifactQuery: options.artifactQuery,
  });
  await managementServer.start();
  process.stdout.write([
    `MetaWork Web: ${managementServer.address}`,
    formatWebAccessTokenLine(options.webAuth.manualAccessToken),
  ].join('\n') + '\n');
  return managementServer;
}

export async function main(cliCommand = parseCliArgs(process.argv.slice(2))) {
  const paths = resolveMetaWorkPaths();
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const applicationRoot = existsSync(paths.appCurrent)
    ? paths.appCurrent
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

  if (cliCommand.kind === 'help') {
    process.stdout.write(`${formatCliHelp()}\n`);
    return;
  }

  // 1. 初始化目录
  const metaclawDir = resolveMetaclawDir();
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  const gatewaySocketPath = resolveGatewaySocketPath(metaclawDir);
  const endpointManifestPath = resolve(paths.root, 'server-endpoint.json');
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  const runtimeLockPath = resolve(paths.data, 'runtime.lock');
  if (cliCommand.kind === 'server' && cliCommand.action === 'status') {
    const instanceRunning = await isInstanceRunning(runtimeLockPath);
    const manifest = await readEndpointManifest(endpointManifestPath).catch(() => null);
    const readiness = classifyServerReadiness(manifest, instanceRunning, {
      isProcessAlive: pid => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      },
      socketExists: existsSync,
    });
    process.stdout.write(readiness === 'ready'
      ? 'MetaWork Server 正在运行。\n'
      : readiness === 'starting_or_failed'
        ? 'MetaWork Server 尚未就绪：正在启动或启动失败，请检查 Server terminal。\n'
        : 'MetaWork Server 未运行。请执行 `metawork server start`。\n');
    return;
  }

  if (cliCommand.kind === 'server' && cliCommand.action === 'stop') {
    const result = await stopInstanceForRestart(runtimeLockPath);
    process.stdout.write(
      result.status === 'stopped'
        ? `MetaWork Server 已停止（PID ${result.pid}）。\n`
        : 'MetaWork Server 未运行。\n',
    );
    return;
  }

  if (cliCommand.kind === 'server' && cliCommand.action === 'restart') {
    const result = await stopInstanceForRestart(runtimeLockPath);
    process.stdout.write(
      result.status === 'stopped'
        ? `MetaWork Server 旧实例已停止（PID ${result.pid}），正在重新启动。\n`
        : 'MetaWork Server 未运行，正在启动。\n',
    );
  }

  if (cliCommand.kind === 'server' && cliCommand.action === 'doctor') {
    const configurationRepository = new FileConfigurationRepository(
      accountPaths.config,
    );
    await configurationRepository.initialize();
    const recovery = await configurationRepository.recover();
    if (recovery.status === 'empty') {
      throw new Error('active configuration is missing; run `anyfusion-install install`');
    }
    const config = buildApplicationConfig(
      await configurationRepository.getActiveSnapshot(),
    );
    console.log(formatGatewayDoctorChecks(runGatewayDoctor({ config, metaclawDir })));
    return;
  }

  if (cliCommand.kind === 'admin') {
    const configurationRepository = new FileConfigurationRepository(
      accountPaths.config,
    );
    await configurationRepository.initialize();
    const recovery = await configurationRepository.recover();
    if (recovery.status === 'empty') {
      throw new Error('active configuration is missing; run `anyfusion-install install`');
    }
    const activeSnapshot = await configurationRepository.getActiveSnapshot();
    const secretStore = createProductionSecretStore({
      secretsRoot: accountPaths.secrets,
      env: process.env,
      references: Object.values(activeSnapshot.config.providers)
        .map(provider => provider.apiKeyRef),
    });
    await prepareProductionSecretStore(secretStore);
    await preheatLocalAgentCredentials(secretStore);
    await importLocalAgentCredentials({
      ...localAgentCredentialSources(),
      providers: activeSnapshot.config.providers,
      secretStore,
    });
    const configurationService = new ConfigurationService({
      repository: configurationRepository,
      renderer: new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime')),
      probe: createProductionConfigurationProbe({
        releaseRoot: applicationRoot,
        secretStore,
      }),
    });
    const lines = await runConfigurationAdmin(cliCommand.command, {
      getActiveSnapshot: () => configurationService.getActiveSnapshot(),
      rollback: async targetRevisionId => toMutationResult(
        await configurationService.rollback(targetRevisionId, activeSnapshot.revisionId),
      ),
      listRevisions: () => configurationRepository.listRevisions(),
      getSnapshot: revisionId => configurationService.getSnapshot(revisionId),
      activate: async config => activateConfiguration(configurationService, config, activeSnapshot.revisionId),
    });
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // Only standalone Server startup owns the Runtime instance lock. Client
  // launchers are separated from this composition in the following tasks.
  let instanceLock: InstanceLock | null = null;
  let instanceLockPath: string | null = null;
  if (cliCommand.kind === 'server') {
    const dataDir = paths.data;
    mkdirSync(dataDir, { recursive: true });
    instanceLockPath = resolve(dataDir, 'runtime.lock');
    instanceLock = await acquireInstanceLock(instanceLockPath);
    process.once('exit', () => {
      if (instanceLockPath) removeInstanceLockOnExit(instanceLockPath);
    });
  }

  // 2. Load the sole active configuration revision. Legacy import belongs to
  // the transactional installer rather than ordinary runtime startup.

  // ADR-0031: 账户数据根——迁移并激活 local-default 账户，运行时使用账户作用域数据。
  await new AccountLayoutMigrator({ paths }).migrate();

  const configurationRepository = new FileConfigurationRepository(accountPaths.config);
  await configurationRepository.initialize();
  const recovery = await configurationRepository.recover();
  if (recovery.status === 'empty') {
    throw new Error('active configuration is missing; run `anyfusion-install install`');
  }
  const migratedSnapshot = await configurationRepository.getActiveSnapshot();
  const config = buildApplicationConfig(migratedSnapshot);
  const markdownPreviewConfig = config.integrations?.markdown_preview;
  const markdownPreviewServer = markdownPreviewConfig?.enabled
    && process.env.METACLAW_DISABLE_MARKDOWN_PREVIEW !== '1'
    ? new MarkdownPreviewServer(markdownPreviewConfig, accountPaths.workspaceStore)
    : null;
  if (markdownPreviewServer && markdownPreviewConfig) {
    try {
      await markdownPreviewServer.start();
      const markdownPreviewBaseUrl = (markdownPreviewConfig.public_base_url
        ?? `http://${markdownPreviewConfig.host}:${markdownPreviewConfig.port}`).replace(/\/+$/, '');
      console.log(
        `Markdown preview listening: ${markdownPreviewBaseUrl}`,
      );
    } catch (error) {
      console.error(`Markdown preview start failed: ${(error as Error).message}`);
    }
  }

  // 3. Bind Planner, Kernel and Runtime to the exact active revision.
  const secretStore = createProductionSecretStore({
    secretsRoot: accountPaths.secrets,
    env: process.env,
    references: Object.values(migratedSnapshot.config.providers)
      .map(provider => provider.apiKeyRef),
  });
  await prepareProductionSecretStore(secretStore);
  await preheatLocalAgentCredentials(secretStore);
  await importLocalAgentCredentials({
    ...localAgentCredentialSources(),
    providers: migratedSnapshot.config.providers,
    secretStore,
  });
  const renderer = new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime'));
  const stagedConfiguration = buildStagedLegacyConfiguration({ migratedSnapshot });
  let accountRuntimeComposition: ReturnType<typeof buildAccountRuntimeComposition> | null = null;
  const configurationActivationGate = new ConfigurationActivationGate(() => (
    accountRuntimeComposition?.accountRuntime.getConfigurationActivationFacts() ?? {
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }
  ));
  const configurationService = new ConfigurationService({
    repository: configurationRepository,
    secretStore,
    renderer,
    activationGate: configurationActivationGate,
    probe: createProductionConfigurationProbe({
      releaseRoot: applicationRoot,
      secretStore,
    }),
  });
  const runtimeBindings = createProductionRuntimeBindings({
    snapshot: migratedSnapshot,
    secretStore,
    getSnapshot: revisionId => configurationRepository.readSnapshot(revisionId),
  });
  const plannerModel = migratedSnapshot.config.models[
    stagedConfiguration.plannerBinding.modelRef
  ];
  if (!plannerModel) {
    throw new Error(
      `Planner Model is unavailable: ${stagedConfiguration.plannerBinding.modelRef}`,
    );
  }
  const plannerRuntimeEnvironment = await resolvePlannerRuntimeEnvironment({
    configuration: runtimeBindings.runtimeConfiguration,
    plannerBinding: stagedConfiguration.plannerBinding,
    secretStore,
  });
  const db = createDatabase(accountPaths.database);
  const configurationRevisionRepo = new ConfigurationRevisionRepo(db);
  ensureActiveConfigurationRevision(db, {
    revisionId: migratedSnapshot.revisionId,
    contentHash: migratedSnapshot.contentHash,
  });

  // 4. 初始化 Repos
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);
  const prefRepo = new PreferenceRepo(db);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 7. Executor availability is resolved at dispatch time by the selected
  // backend. Startup keeps direct reply/query/planning available even when
  // the configured Executor runtime is unavailable.

  // 8. 初始化上下文召回器
  const sessionId = `sess_${nanoid(10)}`;
  const contextRecaller = new ContextRecaller(db);
  const conversationStore = new FileConversationStore(
    resolve(accountPaths.conversations, 'gateway'),
  );
  const workspaceCatalogStore = new FileWorkspaceCatalogStore(accountPaths.workspaceCatalog);
  await new WorkspaceConversationMigrator({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    conversationsRoot: conversationStore.rootDir,
    workspaceCatalogRoot: accountPaths.workspaceCatalog,
  }).migrate();
  await workspaceCatalogStore.initialize();
  await conversationStore.initialize();
  let publishWorkspaceActivity: (
    conversationId: string,
    activity: ConversationActivityProjection,
  ) => Promise<void> = async () => undefined;
  const workspaceDirectory = new WorkspaceDirectoryService({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    workspaceCatalog: workspaceCatalogStore,
    conversationStore,
    authorize: (_path, principalId) => isAuthenticatedWorkspacePrincipalId(principalId),
    createConversationId: () => `conv_${nanoid(12)}`,
    getConversationActivity: (conversationId, fallbackUpdatedAt) => (
      accountRuntimeComposition?.accountRuntime.getConversationActivity(
        conversationId,
        fallbackUpdatedAt,
      ) ?? { state: 'idle', taskId: null, updatedAt: fallbackUpdatedAt }
    ),
  });
  const notifier = createNotificationService(config);
  const plannerHostSocketPath = (process.env.METACLAW_PLANNER_HOST_SOCKET
    ?? process.env.METACLAW_PLANNER_TUI_SOCKET
    ?? resolve(metaclawDir, 'anyfusion-planner.sock')).trim();
  process.env.METACLAW_PLANNER_HOST_SOCKET = plannerHostSocketPath;
  process.env.METACLAW_PLANNER_TUI_SOCKET = plannerHostSocketPath;
  const plannerHost = new PlannerHostBridge({ socketPath: plannerHostSocketPath, logger: console });
  const plannerSupervisor = new PlannerProcessSupervisor({
    socketPath: plannerHostSocketPath,
    gatewaySocketPath,
    configurationRevision: stagedConfiguration.snapshot.revisionId,
    bindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
    generatedRuntimeRoot: resolve(accountPaths.generated, 'agent-runtime'),
    plannerRuntimeRoot: accountPaths.plannerRuntime,
    databasePath: accountPaths.database,
    configurationRoot: accountPaths.config,
    schemaPath: resolve(applicationRoot, 'dist', 'planning-agent-plan-v8.schema.json'),
    sessionDir: accountPaths.plannerSessions,
    runtimeEnvironment: plannerRuntimeEnvironment,
    expectedModel: {
      provider: stagedConfiguration.plannerBinding.providerRef,
      modelId: plannerModel.modelId,
    },
    resolvePlannerBinding: async context => {
      const inputProfile = buildPlannerInputProfile(context);
      const activeSnapshot = await configurationRepository.getActiveSnapshot();
      const activePlanner = buildPlannerConfigurationView(activeSnapshot);
      const plannerRouting = activePlanner.planner;
      if (!plannerRouting) throw new Error('Planner routing policy is unavailable');
      const resolution = AutoModelResolver.resolve({
        configurationRevision: activeSnapshot.revisionId,
        agentClassRef: 'planner',
        harnessRef: plannerRouting.harnessRef,
        permissionProfileRef: 'planner-none',
        policy: plannerRouting.modelPolicy,
        candidates: await Promise.all(activePlanner.models.map(async model => {
          const provider = activeSnapshot.config.providers[model.providerRef];
          let credentialAvailable = false;
          if (provider) {
            try {
              assertSecretReference(provider.apiKeyRef);
              credentialAvailable = (await secretStore.get(provider.apiKeyRef)).trim().length > 0;
            } catch {
              credentialAvailable = false;
            }
          }
          return {
            providerRef: model.providerRef,
            modelRef: model.id,
            modelId: activeSnapshot.config.models[model.id]?.modelId ?? model.id,
            capabilities: model.capabilities,
            contextLimit: model.contextLimit,
            costInputPerMillion: model.costInputPerMillion,
            costOutputPerMillion: model.costOutputPerMillion,
            latencyTier: model.latencyTier,
            qualityTier: model.qualityTier,
            health: credentialAvailable ? 'healthy' as const : 'unavailable' as const,
            available: credentialAvailable,
            providerEnabled: provider?.enabled ?? false,
            harnessCompatible: Boolean(
              activeSnapshot.config.harnesses[plannerRouting.harnessRef]?.enabled,
            ),
          };
        })),
        requirements: {
          preferredCapabilities: inputProfile.preferredCapabilities,
          contextTokens: inputProfile.contextTokens,
          requiresStructuredOutput: inputProfile.requiresStructuredOutput,
        },
      });
      if (!resolution.binding) throw new Error('Planner Auto routing returned no binding');
      const model = activeSnapshot.config.models[resolution.binding.modelRef];
      if (!model) throw new Error(`Planner Model is unavailable: ${resolution.binding.modelRef}`);
      const plannerBinding = {
        ...resolution.binding,
        permissionProfileRef: null,
      };
      return {
        configurationRevision: resolution.binding.configurationRevision,
        bindingFingerprint: authorizedExecutorBindingFingerprint(resolution.binding),
        provider: resolution.binding.providerRef,
        modelId: model.modelId,
        runtimeEnvironment: await resolvePlannerRuntimeEnvironment({
          configuration: runtimeBindings.getRuntimeConfiguration(activeSnapshot.revisionId)
            ?? runtimeBindings.getActiveRuntimeConfiguration(),
          plannerBinding,
          secretStore,
        }),
      };
    },
  });
  await plannerHost.start();

  // ADR-0031: 组合根构造 RuntimeRegistry + AccountRuntime（local-default），
  // 会话工厂复用 AccountRuntime 的账户级服务簇。
  accountRuntimeComposition = buildAccountRuntimeComposition({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    db,
    taskEngine,
    memoryEngine,
    orchestration,
    contextRecaller,
    notifier,
    workspaceRoot: accountPaths.workspaceStore,
    attemptsRoot: accountPaths.attempts,
    resultsRoot: accountPaths.results,
    generatedRuntimeRoot: accountPaths.generatedAgentRuntime,
    sourceRoot: accountPaths.workspaceStore,
    resolveUserWorkspaceRoot: async conversationId => {
      const binding = (await conversationStore.readConversation(conversationId))
        ?.conversation.workspaceBinding;
      if (!binding) return null;
      return (await workspaceCatalogStore.findById(binding.workspaceId))?.canonicalPath ?? null;
    },
    sessionId,
    stagedConfiguration,
    plannerBinding: stagedConfiguration.plannerBinding,
    plannerBindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
    getPlannerBinding: () => ({
      plannerBinding: stagedConfiguration.plannerBinding,
      plannerBindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
    }),
    getRuntimeBinding: runtimeBindings.getRuntimeBinding,
    getRuntimeConfiguration: runtimeBindings.getRuntimeConfiguration,
    getActiveRuntimeConfiguration: runtimeBindings.getActiveRuntimeConfiguration,
    configurationActivationGate,
    plannerSupervisor,
    getConfigurationRevision: () => stagedConfiguration.snapshot.revisionId,
    blockedRecheckEnabled: config.orchestration.blocked_recheck_enabled !== false,
    blockedRecheckIntervalMs: Math.max(
      config.orchestration.blocked_recheck_interval ?? 60,
      5,
    ) * 1000,
    onConversationActivityChanged: (conversationId, activity) => (
      publishWorkspaceActivity(conversationId, activity)
    ),
  });
  const accountRegistry = new RuntimeRegistry({
    // The composition helper has already bound all account-scoped services to
    // the account data root. Registry activation owns lifecycle/recovery; it
    // must not construct a second service graph for the same account.
    factory: {
      create: () => accountRuntimeComposition.accountRuntime,
    },
  });
  const activatedAccountRuntime = await accountRegistry.getOrActivate({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    authorized: true,
  });
  let gatewayFeishuManager: FeishuRuntimeManager | null = null;
  const configurationRuntimeCoordinator = new ConfigurationRuntimeCoordinator({
    service: configurationService,
    gate: configurationActivationGate,
    initialSnapshot: migratedSnapshot,
    prepareConfig: async ({ config, secrets }) => {
      let prepared = structuredClone(config) as AnyFusionConfigurationV2;
      for (const [providerRef, apiKey] of Object.entries(secrets)) {
        const reference = secretStore instanceof FileSecretStore
          ? `file-secret:anyfusion/providers/${providerRef}` as const
          : `keychain:anyfusion/providers/${providerRef}` as const;
        const provider = prepared.providers[providerRef];
        if (provider) provider.apiKeyRef = reference;
      }
      return prepared;
    },
    stageSecrets: async secrets => {
      const previous = new Map<string, string | null>();
      const references = new Map<string, SecretReference>();
      for (const [providerRef, apiKey] of Object.entries(secrets)) {
        const reference = secretStore instanceof FileSecretStore
          ? `file-secret:anyfusion/providers/${providerRef}` as const
          : `keychain:anyfusion/providers/${providerRef}` as const;
        references.set(providerRef, reference);
        try {
          previous.set(providerRef, await secretStore.get(reference));
        } catch {
          previous.set(providerRef, null);
        }
      }
      try {
        for (const [providerRef, apiKey] of Object.entries(secrets)) {
          await secretStore.put(references.get(providerRef)!, apiKey.trim());
        }
      } catch (error) {
        for (const [providerRef, value] of previous) {
          const reference = references.get(providerRef)!;
          if (value === null) await secretStore.delete(reference);
          else await secretStore.put(reference, value);
        }
        throw error;
      }
      return async () => {
        for (const [providerRef, value] of previous) {
          const reference = references.get(providerRef)!;
          if (value === null) await secretStore.delete(reference);
          else await secretStore.put(reference, value);
        }
      };
    },
    registerRevision: (snapshot, reason) => {
      const existing = configurationRevisionRepo.find(snapshot.revisionId);
      configurationRevisionRepo.ensure({
        revisionId: snapshot.revisionId,
        contentHash: snapshot.contentHash,
        sourceKind: existing?.sourceKind ?? (reason === 'rollback' ? 'rollback' : 'native'),
        importedAt: existing?.importedAt ?? new Date().toISOString(),
      });
    },
    onActivated: async ({ snapshot, runtime }) => {
      const nextStaged = buildStagedLegacyConfiguration({ migratedSnapshot: snapshot });
      const nextPlannerModel = snapshot.config.models[nextStaged.plannerBinding.modelRef];
      if (!nextPlannerModel) {
        throw new Error(`Planner Model is unavailable: ${nextStaged.plannerBinding.modelRef}`);
      }
      const runtimeEnvironment = await resolvePlannerRuntimeEnvironment({
        configuration: runtime,
        plannerBinding: nextStaged.plannerBinding,
        secretStore,
      });
      await plannerSupervisor.refreshBinding({
        configurationRevision: nextStaged.snapshot.revisionId,
        bindingFingerprint: nextStaged.plannerBindingFingerprint,
        provider: nextStaged.plannerBinding.providerRef,
        modelId: nextPlannerModel.modelId,
        runtimeEnvironment,
      });
      runtimeBindings.updateSnapshot(snapshot);
      stagedConfiguration.snapshot = nextStaged.snapshot;
      stagedConfiguration.planner = nextStaged.planner;
      stagedConfiguration.kernel = nextStaged.kernel;
      stagedConfiguration.plannerBinding = nextStaged.plannerBinding;
      stagedConfiguration.plannerBindingFingerprint = nextStaged.plannerBindingFingerprint;
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
    },
    onActivationFailed: async ({ snapshot, runtime }) => {
      const restored = buildStagedLegacyConfiguration({ migratedSnapshot: snapshot });
      const restoredModel = snapshot.config.models[restored.plannerBinding.modelRef];
      if (!restoredModel) {
        throw new Error(`Planner Model is unavailable after activation rollback: ${restored.plannerBinding.modelRef}`);
      }
      const runtimeEnvironment = await resolvePlannerRuntimeEnvironment({
        configuration: runtime,
        plannerBinding: restored.plannerBinding,
        secretStore,
      });
      await plannerSupervisor.refreshBinding({
        configurationRevision: restored.snapshot.revisionId,
        bindingFingerprint: restored.plannerBindingFingerprint,
        provider: restored.plannerBinding.providerRef,
        modelId: restoredModel.modelId,
        runtimeEnvironment,
      });
      runtimeBindings.updateSnapshot(snapshot);
      stagedConfiguration.snapshot = restored.snapshot;
      stagedConfiguration.planner = restored.planner;
      stagedConfiguration.kernel = restored.kernel;
      stagedConfiguration.plannerBinding = restored.plannerBinding;
      stagedConfiguration.plannerBindingFingerprint = restored.plannerBindingFingerprint;
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
    },
  });
  const runtimePort = activatedAccountRuntime.getConversationPort();
  const conversationRegistry = new ConversationRegistry();

  // ADR-0031: 直接构造 ConversationSession（不经过 MetaclawSession 桥接），
  // 会话级 callbacks + 账户级 Kernel 执行服务后置绑定。
  const buildConversationSession = async (conversationId: string): Promise<ConversationSession> => {
    let record = await conversationStore.readConversation(conversationId);
    if (!record) {
      const now = new Date().toISOString();
      record = {
        version: CONVERSATION_FORMAT_VERSION,
        conversation: {
          id: conversationId,
          plannerSessionId: conversationId,
          accountId: LOCAL_DEFAULT_ACCOUNT_ID,
          title: 'New conversation',
          createdAt: now,
          updatedAt: now,
          archived: false,
          workspaceBinding: null,
        },
        turns: [],
      } satisfies ConversationRecord;
      await conversationStore.writeConversation(record);
      const catalog = await conversationStore.readCatalog();
      await conversationStore.writeCatalog({
        ...catalog,
        conversations: [
          ...catalog.conversations.filter(item => item.id !== conversationId),
          record.conversation,
        ],
      });
    }
    const port = runtimePort;
    const persistenceService = new SessionPersistenceService(db);
    const presentation = new SessionPresentationService();
    const sessionStateRepo = new SessionStateRepo(db);
    const interactionTraceStream = new InteractionTraceStream(conversationId);
    const planningContextBuilder = new PlanningContextBuilder({
      sessionId: conversationId,
      requestSource: 'session',
      getTimeoutMs: () => {
        const configured = Number(process.env.METACLAW_PLANNER_TIMEOUT_MS);
        return Number.isFinite(configured) && configured > 0 ? configured : 180_000;
      },
      getPlannerConfiguration: () => stagedConfiguration.planner,
    });
    const commandCatalog = createDefaultCommandCatalog();
    const commandReadServices = new CommandReadServices(db, accountRuntimeComposition.executionRuntime, {
      getConfigurationRevision: () => stagedConfiguration.snapshot.revisionId,
    });

    let conversation!: ConversationSession;
    const workspace = new ConversationWorkspaceService({
      store: conversationStore,
      workspaceCatalog: workspaceCatalogStore,
      conversationId,
      isBusy: () => {
        if (!conversation) return false;
        const switching = conversation.getSwitchingState();
        return switching.plannerTurnActive || switching.taskRuntimeActive;
      },
    });
    conversation = new ConversationSession({
      conversationId,
      plannerSessionId: conversationId,
      runtimePort: port,
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      presentation,
      sessionStateRepo,
      persistenceService,
      interactionTraceStream,
      planningContextBuilder,
      db,
      getKernelConfiguration: () => stagedConfiguration.kernel,
      getRuntimeConfiguration: runtimeBindings.getRuntimeConfiguration,
      commandCatalog,
      commandReadServices,
      taskEngine,
      memoryEngine,
      orchestration,
      config,
      plannerProposalRepo: new PlannerProposalRepo(db),
      workspace,
      dispose: async () => unregisterPlannerHost(),
    });
    const unregisterPlannerHost = plannerHost.registerSession(conversationId, conversation);

    const binder = accountRuntimeComposition.conversationExecutionBinder;
    const kernelExecutionServices = binder.bind({
      sessionId: conversationId,
      persistenceService,
      presentation,
      ...conversation.getKernelExecutionCallbacks(),
    });

    conversation.bindKernelExecutionRuntime(kernelExecutionServices.kernelExecutionRuntime);
    conversation.bindSessionKernelRuntime(kernelExecutionServices.sessionKernelRuntime);
    conversation.bindTaskExecutionApplicationService(kernelExecutionServices.taskExecutionApplicationService);

    return conversation;
  };
  const conversationBindings = new ConversationBindingRepository(
    resolve(accountPaths.gateway, 'conversation-bindings.json'),
  );
  await conversationBindings.initialize();
  const eventJournal = new FileEventJournal(resolve(accountPaths.gateway, 'events'));
  const normalizeTurnPresentation = (turn: ConversationTurn): ConversationTurn => {
    if (!turn.taskId) return structuredClone(turn);
    const graphDecision = [...new KernelDecisionRepo(db).listByTask(turn.taskId)]
      .reverse()
      .find(record => record.decision.action.type === 'authorize_task_plan');
    const action = graphDecision?.decision.action;
    if (!action || action.type !== 'authorize_task_plan') return structuredClone(turn);
    return normalizeExecutionPresentation(
      turn,
      buildCanonicalSubtaskIdentityMap(
        action.taskId,
        action.graphRevision,
        action.workGraph.subtasks,
      ),
    );
  };
  const webSessionCatalog = new WebSessionCatalog({
    directory: workspaceDirectory,
    conversationStore,
    presentationStore: new FileConversationPresentationStore(
      resolve(accountPaths.conversations, 'web-presentation'),
    ),
    normalizeTurnPresentation,
  });
  const webAttachmentStore = new FileAttachmentStore(
    resolve(accountPaths.conversations, 'web-attachments'),
  );
  await webAttachmentStore.initialize();
  const knownConversationIds = new Set<string>([sessionId]);
  const rememberConversation = (accountId: string, conversationId: string): void => {
    if (accountId === LOCAL_DEFAULT_ACCOUNT_ID) knownConversationIds.add(conversationId);
  };
  const durableConversation = db.prepare(`
    SELECT 1 AS owned
    WHERE EXISTS (SELECT 1 FROM interactions WHERE session_id = ?)
       OR EXISTS (SELECT 1 FROM planner_runs WHERE session_id = ?)
       OR EXISTS (SELECT 1 FROM planner_proposal_turns WHERE session_id = ?)
       OR EXISTS (SELECT 1 FROM kernel_events WHERE session_id = ?)
       OR EXISTS (SELECT 1 FROM kernel_decisions WHERE session_id = ?)
  `);
  const authorizeConversationAttach = async (
    accountId: string,
    conversationId: string,
  ): Promise<boolean> => {
    if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return false;
    if (knownConversationIds.has(conversationId)) return true;
    if (conversationRegistry.getIfOpen(conversationId)) return true;
    try {
      if (await webSessionCatalog.read(conversationId)) return true;
      const owned = durableConversation.get(
        conversationId,
        conversationId,
        conversationId,
        conversationId,
        conversationId,
      ) as { owned: number } | undefined;
      if (owned) return true;
      return (await eventJournal.replay(accountId, conversationId)).lastSequence > 0;
    } catch {
      return false;
    }
  };
  const conversationResolver = new BindingConversationResolver({
    bindings: conversationBindings,
    createId: () => {
      const conversationId = `conv_${nanoid(12)}`;
      rememberConversation(LOCAL_DEFAULT_ACCOUNT_ID, conversationId);
      return conversationId;
    },
    verifyOwnership: authorizeConversationAttach,
    createInWorkspace: async (accountId, workspaceId, principalId) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) {
        throw new Error('workspace_unauthorized');
      }
      const conversation = await workspaceDirectory.createConversation(
        workspaceId,
        principalId,
      );
      rememberConversation(accountId, conversation.id);
      return conversation.id;
    },
  });
  const gatewaySubscriptions = new GatewaySubscriptions();
  const conversationGatewayRuntime = new ConversationGatewayRuntime({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    registry: accountRegistry,
    conversations: conversationRegistry,
    conversationFactory: buildConversationSession,
    journal: eventJournal,
    subscriptions: gatewaySubscriptions,
    attachments: webAttachmentStore,
    readHistory: async (conversationId, cursor, requestedLimit) => {
      const record = await conversationStore.readConversation(conversationId);
      if (!record) throw new Error('conversation_not_found');
      const limit = Math.min(Math.max(requestedLimit ?? 10, 1), 50);
      const offset = decodeHistoryCursor(cursor);
      const ordered = [...record.turns].reverse();
      const turns = ordered.slice(offset, offset + limit);
      return {
        turns,
        previousCursor: offset > 0
          ? encodeHistoryCursor(Math.max(0, offset - limit))
          : null,
        nextCursor: offset + turns.length < ordered.length
          ? encodeHistoryCursor(offset + turns.length)
          : null,
      };
    },
  });
  const workspaceGatewayRuntime = new WorkspaceGatewayRuntime(workspaceDirectory, {
    publish: async (kind, workspaceId, payload) => {
      const event = await eventJournal.append({
        protocolVersion: 2,
        eventId: `event_${nanoid(12)}`,
        sequence: 0,
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        conversationId: workspaceEventStreamId(workspaceId),
        requestId: null,
        turnId: null,
        kind,
        payload: { workspaceId, ...asPayloadRecord(payload) },
        occurredAt: new Date().toISOString(),
      });
      gatewaySubscriptions.publish(event);
    },
    publishConnection: async (kind, connectionId, payload, requestId) => {
      const event = await eventJournal.append({
        protocolVersion: 2,
        eventId: `event_${nanoid(12)}`,
        sequence: 0,
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        conversationId: clientConnectionEventStreamId(connectionId),
        requestId: requestId ?? null,
        turnId: null,
        kind,
        payload: asPayloadRecord(payload),
        occurredAt: new Date().toISOString(),
      });
      gatewaySubscriptions.publish(event);
    },
  });
  publishWorkspaceActivity = async (conversationId, activity) => {
    const binding = (await conversationStore.readConversation(conversationId))
      ?.conversation.workspaceBinding;
    if (!binding) return;
    await workspaceGatewayRuntime.publishActivity(binding.workspaceId, {
      conversationId,
      activity,
    });
  };
  const clientGateway = new ClientGateway({
    authenticator: {
      authenticate: async ({ transport, credential }) => {
        if (transport === 'local') return { kind: 'local', id: 'local-installation' };
        if (transport === 'web') return { kind: 'web', id: 'local-web-user' };
        if (transport === 'feishu') {
          const sender = credential as { tenantKey?: string; userId?: string } | undefined;
          return sender?.tenantKey && sender.userId
            ? { kind: 'feishu', id: `${sender.tenantKey}:${sender.userId}` }
            : null;
        }
        return null;
      },
    },
    accountResolver: {
      resolve: async () => ({
        status: 'authorized',
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      }),
    },
    conversationResolver,
    commandAdmissionStore: new FileCommandAdmissionStore(
      resolve(accountPaths.gateway, 'command-admissions'),
    ),
    activateAccount: accountId => conversationGatewayRuntime.activateAccount(accountId).then(() => undefined),
    submitToConversation: (conversationId, requestId, idempotencyKey, command, principalId, origin) =>
      conversationGatewayRuntime.submit(
        conversationId,
        requestId,
        idempotencyKey,
        command,
        principalId,
        origin,
      ),
    handleWorkspaceCommand: (command, context) =>
      workspaceGatewayRuntime.handle(command, context),
  });
  const webGatewayAdapter = new WebGatewayAdapter({
    gateway: clientGateway,
    journal: eventJournal,
    subscriptions: gatewaySubscriptions,
    attachClient: (accountId, conversationId) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) {
        throw new Error(`account runtime is unavailable: ${accountId}`);
      }
      return conversationGatewayRuntime.attachClient(conversationId);
    },
  });
  const webLaunchContexts = new WebLaunchContextService();
  const webAuth = new WebAuthService({ launchContexts: webLaunchContexts });

  const gatewayServer = new MetaclawGatewayServer({
    socketPath: gatewaySocketPath,
    gateway: clientGateway,
    journal: eventJournal,
    subscriptions: gatewaySubscriptions,
    authorizeAttach: authorizeConversationAttach,
    attachClient: (accountId, conversationId) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) {
        throw new Error(`account runtime is unavailable: ${accountId}`);
      }
      return conversationGatewayRuntime.attachClient(conversationId);
    },
    resolveConversationWorkspaceId: async (accountId, conversationId) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return null;
      return workspaceDirectory.resolveConversationWorkspace(
        conversationId,
        'local:local-installation',
      );
    },
    activateConnectionWorkspace: (connectionId, workspaceId) => {
      workspaceGatewayRuntime.restoreConnectionWorkspace(connectionId, workspaceId);
    },
    publishWorkspaceSnapshot: workspaceId => {
      return workspaceGatewayRuntime.publishWorkspaceSnapshot(
        workspaceId,
        'local:local-installation',
      );
    },
    closeConnection: connectionId => {
      workspaceGatewayRuntime.closeConnection(connectionId);
    },
    registerWebLaunch: input => Promise.resolve(webLaunchContexts.issue(input)),
  });
  let managementServer: ManagementServer | null = null;
  const taskPoolReviewTimer = setInterval(() => {
    void accountRuntimeComposition.accountRuntime.reviewTaskPoolOnTimer().catch((error: unknown) => {
      console.error(`Account Runtime periodic review failed: ${(error as Error).message}`);
    });
  }, Math.max(config.orchestration.blocked_recheck_interval ?? 60, 5) * 1000);
  taskPoolReviewTimer.unref?.();
  let serverApplication: ReturnType<typeof createServerApplication> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = serverApplication?.stop() ?? Promise.resolve();
    return shutdownPromise;
  };
  process.once('exit', () => {
    clearInterval(taskPoolReviewTimer);
  });
  const shutdownForSignal = (): void => {
    void shutdown().then(
      () => process.exit(0),
      error => {
        console.error(`MetaWork shutdown failed: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => {
    shutdownForSignal();
  });
  process.once('SIGTERM', () => {
    shutdownForSignal();
  });

  await gatewayServer.start();
  if (cliCommand.kind === 'server') {
    const feishuRouting = new FeishuConversationRouting({
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      gateway: clientGateway,
      bindings: conversationBindings,
      restoreWorkspace: (connectionId, workspaceId, principalId) =>
        workspaceGatewayRuntime.activateWorkspace(
          connectionId,
          workspaceId,
          principalId,
        ),
      resolveConversationWorkspace: async (
        accountId,
        conversationId,
        principalId,
      ) => {
        if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return null;
        return workspaceDirectory.resolveConversationWorkspace(
          conversationId,
          principalId,
        );
      },
    });
    const feishuPort = new FeishuGatewaySessionPort({
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      tenantKey: config.gateway?.platforms?.feishu?.app_id ?? 'local-feishu-app',
      adapter: new FeishuGatewayAdapter({
        gateway: clientGateway,
        routing: feishuRouting,
      }),
      journal: eventJournal,
      subscriptions: gatewaySubscriptions,
      onSystemMessage: (...lines) => console.log(lines.join('\n')),
      runtimePaths: {
        pairing: resolve(accountPaths.gateway, 'feishu-pairings.json'),
        audit: resolve(accountPaths.gateway, 'gateway-audit.jsonl'),
        uploads: resolve(accountPaths.gateway, 'feishu-uploads'),
        replies: resolve(accountPaths.gateway, 'feishu-replies'),
        config: resolve(accountPaths.config, 'config.yaml'),
      },
    });
    gatewayFeishuManager = new FeishuRuntimeManager({ session: feishuPort });
    await gatewayFeishuManager.applyConfiguration(config);
  }

  if (cliCommand.kind === 'server') {
    const taskArtifactRepo = new TaskArtifactRepo(db);
    const executionProjector = new ExecutionProjector({
      subtaskRepo: new SubtaskRepo(db),
      receiptRepo: new ExecutorAttemptReceiptRepo(db),
      decisionRepo: new KernelDecisionRepo(db),
      publicationRepo: new WorkspacePublicationRepo(db),
      attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db),
      dispatchItemRepo: new KernelDispatchItemRepo(db),
    });
    const workGraphPresentationProjector = new WorkGraphPresentationProjector();
    managementServer = await startWebMode({
      port: resolveServerWebPort(process.env),
      noOpen: true,
      runningRevisionId: stagedConfiguration.snapshot.revisionId,
      attachmentStore: webAttachmentStore,
      artifactQuery: new ArtifactPreviewService({
        taskArtifactSource: taskArtifactRepo,
        query: {
          authorize: (accountId, taskId) =>
            accountId === LOCAL_DEFAULT_ACCOUNT_ID && Boolean(taskRepo.findById(taskId)),
          currentAccountId: () => LOCAL_DEFAULT_ACCOUNT_ID,
        },
        userWorkspaceRoot: accountPaths.workspaceStore,
        userWorkspaceRoots: async () => (
          (await workspaceCatalogStore.readCatalog()).workspaces
            .filter(workspace => !workspace.archived && workspace.availability === 'available')
            .map(workspace => workspace.canonicalPath)
        ),
      }),
      webAuth,
      sessionRuntime: new WebGatewaySessionRuntime({
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        catalog: webSessionCatalog,
        gateway: webGatewayAdapter,
        attachments: webAttachmentStore,
        normalizeTurnPresentation,
        projectExecutionTimeline: taskId => {
          const task = taskRepo.findById(taskId);
          return task ? executionProjector.project(task) : null;
        },
        projectTaskArtifacts: taskId => taskArtifactRepo.listByTask(taskId)
          .filter(artifact => (
            artifact.accountId === LOCAL_DEFAULT_ACCOUNT_ID
            && artifact.status === 'published'
          ))
          .map(artifact => taskArtifactRepo.toProjection(artifact)),
      }),
      executionQuery: {
        listTasks: () => taskEngine.list().map(task => ({
          id: task.id,
          title: task.title,
          status: task.status,
          updatedAt: task.updatedAt,
        })),
        projectTimeline: taskId => {
          const task = taskRepo.findById(taskId);
          return task ? executionProjector.project(task) : null;
        },
        projectWorkGraph: taskId => {
          const task = taskRepo.findById(taskId);
          if (!task) return null;
          const subtasks = new SubtaskRepo(db).listByTask(taskId);
          const decisions = new KernelDecisionRepo(db).listByTask(taskId);
          const graphDecision = [...decisions].reverse().find(record => (
            record.decision.action.type === 'authorize_task_plan'
          ));
          if (!graphDecision) return null;
          const planAction = graphDecision.decision.action;
          if (planAction.type !== 'authorize_task_plan') return null;
          const graph = planAction.workGraph;
          const dispatchItems = new KernelDispatchItemRepo(db).listByTask(taskId);
          const receipts = new ExecutorAttemptReceiptRepo(db).listByTask(taskId);
          const publications = new WorkspacePublicationRepo(db).listByTask(taskId);
          const firstDispatchOrder = new Map<string, number>();
          for (const item of dispatchItems) {
            const current = firstDispatchOrder.get(item.subtaskId);
            if (current === undefined || item.batchOrder < current) {
              firstDispatchOrder.set(item.subtaskId, item.batchOrder);
            }
          }
          const planDecisionFacts = Object.entries(
            planAction.authorizedBindingsBySubtask,
          ).map(([subtaskId, authorizedBindings]) => ({
            taskId,
            subtaskId,
            action: graphDecision.action,
            authorizedBindings,
            routing: planAction.routing?.[subtaskId],
          }));
          return workGraphPresentationProjector.project({
            taskId,
            graphRevision: planAction.graphRevision,
            configuration: runtimeBindings.getRuntimeConfiguration(graph.configurationRevision)
              ?? runtimeBindings.getActiveRuntimeConfiguration(),
            graph,
            subtasks: subtasks.map(subtask => ({
              id: subtask.id,
              status: subtask.status,
              generationId: subtask.generationId,
              firstDispatchOrder: firstDispatchOrder.get(subtask.id) ?? null,
              hasPendingOrActiveAttempt: dispatchItems.some(item => (
                item.subtaskId === subtask.id
                && ['pending_launch', 'launching', 'running', 'cancelling', 'uncertain'].includes(item.status)
              )),
            })),
            decisions: planDecisionFacts,
            dispatchItems: dispatchItems.map(item => ({
              subtaskId: item.subtaskId,
              status: item.status,
              authorizedBinding: item.authorizedBinding,
            })),
            receipts: receipts.map(receipt => ({
              subtaskId: receipt.subtaskId,
              attemptId: receipt.attemptId,
              terminalState: receipt.terminalState,
              authorizedBinding: receipt.authorizedBinding,
            })),
            publications: publications.map(publication => ({
              subtaskId: publication.subtaskId,
              status: publication.status,
            })),
          });
        },
      },
      configQuery: {
        getActive: async () => {
          const snapshot = await configurationService.getActiveSnapshot();
          return {
            revisionId: snapshot.revisionId,
            contentHash: snapshot.contentHash,
            config: snapshot.config,
          };
        },
        listRevisions: async () => {
          const revisionIds = await configurationRepository.listRevisions();
          const active = await configurationService.getActiveSnapshot();
          return revisionIds.map(revisionId => ({
            revisionId,
            active: revisionId === active.revisionId,
          }));
        },
        getSnapshot: async revisionId => {
          try {
            const snapshot = await configurationService.getSnapshot(revisionId);
            return {
              revisionId: snapshot.revisionId,
              contentHash: snapshot.contentHash,
              config: snapshot.config,
            };
          } catch {
            return null;
          }
        },
        getCompletion: async () => {
          const snapshot = await configurationService.getActiveSnapshot();
          const providerCatalog = await Promise.all(
            Object.entries(snapshot.config.providers).map(async ([providerRef, provider]) => {
              let credentialAvailable = false;
              try {
                assertSecretReference(provider.apiKeyRef);
                credentialAvailable = (await secretStore.get(provider.apiKeyRef)).trim().length > 0;
              } catch {
                credentialAvailable = false;
              }
              return {
                providerRef,
                baseUrl: provider.baseUrl,
                credentialAvailable,
                modelIds: Object.values(snapshot.config.models)
                  .filter(model => model.providerRef === providerRef)
                  .map(model => model.modelId),
              };
            }),
          );
          return new ConfigurationCompletionService({
            providerCatalog,
            presets: PUBLIC_PROVIDER_PRESETS,
          }).complete({
            providers: Object.fromEntries(
              Object.entries(snapshot.config.providers).map(([providerRef, provider]) => [
                providerRef,
                {
                  baseUrl: provider.baseUrl,
                  credentialAvailable: providerCatalog
                    .find(item => item.providerRef === providerRef)?.credentialAvailable ?? false,
                },
              ]),
            ),
            models: Object.fromEntries(
              Object.entries(snapshot.config.models).map(([modelRef, model]) => [
                modelRef,
                {
                  providerRef: model.providerRef,
                  modelId: model.modelId,
                  capabilities: model.capabilities,
                  contextLimit: model.contextLimit,
                  costInputPerMillion: model.costInputPerMillion,
                  costOutputPerMillion: model.costOutputPerMillion,
                  latencyTier: model.latencyTier,
                  qualityTier: model.qualityTier,
                },
              ]),
            ),
            agentClasses: snapshot.config.agentClasses as unknown as Record<string, Record<string, unknown>>,
          });
        },
        activate: async (baseRevisionId, nextConfig, secrets) => {
          const result = await configurationRuntimeCoordinator.activate({
            expectedRevisionId: baseRevisionId,
            config: nextConfig as AnyFusionConfigurationV2,
            secrets,
          });
          if (result.ok) {
            return {
              ok: true,
              revisionId: result.snapshot.revisionId,
              activeRevisionId: result.snapshot.revisionId,
              runningRevisionId: result.snapshot.revisionId,
              restartRequired: false,
            };
          }
          return {
            ok: false,
            code: result.code,
            activeRevisionId: result.activeRevisionId,
            issues: result.issues,
            restartRequired: result.code === 'restart_required',
            restartPaths: result.restartPaths,
          };
        },
        rollback: async targetRevisionId => {
          const active = await configurationService.getActiveSnapshot();
          const target = await configurationService.getSnapshot(targetRevisionId);
          const result = await configurationRuntimeCoordinator.activate({
            expectedRevisionId: active.revisionId,
            config: target.config,
            reason: 'rollback',
          });
          return result.ok
            ? {
              ok: true,
              revisionId: result.snapshot.revisionId,
              activeRevisionId: result.snapshot.revisionId,
              runningRevisionId: result.snapshot.revisionId,
              restartRequired: false,
            }
            : {
              ok: false,
              code: result.code,
              activeRevisionId: result.activeRevisionId,
              issues: result.issues,
              restartRequired: result.code === 'restart_required',
              restartPaths: result.restartPaths,
            };
        },
        writeSecret: async (providerRef, apiKey) => {
          const reference = secretStore instanceof FileSecretStore
            ? `file-secret:anyfusion/providers/${providerRef}` as const
            : `keychain:anyfusion/providers/${providerRef}` as const;
          await secretStore.put(reference, apiKey);
          return { apiKeyRef: reference };
        },
        getSecretStatus: async providerRefs => {
          const references = Object.fromEntries(providerRefs.map(providerRef => [
            providerRef,
            secretStore instanceof FileSecretStore
              ? `file-secret:anyfusion/providers/${providerRef}` as const
              : `keychain:anyfusion/providers/${providerRef}` as const,
          ]));
          await importLocalAgentCredentialsForRefs({
            ...localAgentCredentialSources(),
            providers: references,
            secretStore,
          });
          const status: Record<string, boolean> = {};
          for (const providerRef of providerRefs) {
            const reference = secretStore instanceof FileSecretStore
              ? `file-secret:anyfusion/providers/${providerRef}` as const
              : `keychain:anyfusion/providers/${providerRef}` as const;
            try {
              status[providerRef] = (await secretStore.get(reference)).trim().length > 0;
            } catch {
              status[providerRef] = false;
            }
          }
          return status;
        },
        verifySecret: async (providerRef, requestedBaseUrl) => {
          const reference = secretStore instanceof FileSecretStore
            ? `file-secret:anyfusion/providers/${providerRef}` as const
            : `keychain:anyfusion/providers/${providerRef}` as const;
          let apiKey: string;
          try {
            apiKey = (await secretStore.get(reference)).trim();
          } catch {
            return { configured: false, valid: null };
          }
          if (!apiKey) return { configured: false, valid: null };
          let baseUrl = requestedBaseUrl?.trim() ?? '';
          try {
            if (!baseUrl) {
              const active = await configurationService.getActiveSnapshot();
              const config = active.config as { providers?: Record<string, { baseUrl?: string }> };
              baseUrl = String(config.providers?.[providerRef]?.baseUrl ?? '');
            }
          } catch {
            baseUrl = '';
          }
          if (!baseUrl) return { configured: true, valid: null, detail: 'provider baseUrl unknown' };
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8_000);
            const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (response.status === 401 || response.status === 403) {
              return { configured: true, valid: false, detail: `HTTP ${response.status}` };
            }
            return { configured: true, valid: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
          } catch (error) {
            return { configured: true, valid: null, detail: `network: ${(error as Error).message.slice(0, 120)}` };
          }
        },
      },
      configurationRuntime: configurationRuntimeCoordinator,
    });
    const webOrigin = managementServer?.address ?? 'http://127.0.0.1:8788';
    const composition = createServerComposition({
      startListeners: async () => ({ unixSocketPath: gatewaySocketPath, webOrigin }),
      stopListeners: async () => {
        clientGateway.closeAdmission();
        conversationGatewayRuntime.closeAdmission();
        await Promise.all([
          managementServer?.stop() ?? Promise.resolve(),
          gatewayFeishuManager?.stop() ?? Promise.resolve(),
          gatewayServer.stop(),
          markdownPreviewServer?.stop() ?? Promise.resolve(),
        ]);
      },
      drain: async () => {
        clearInterval(taskPoolReviewTimer);
        await clientGateway.drain();
        await conversationGatewayRuntime.drain();
        await conversationRegistry.closeAll();
      },
      stopRuntime: async () => {
        await Promise.all([
          plannerHost.stop(),
          plannerSupervisor.stop(),
        ]);
        await accountRegistry.shutdown();
      },
    });
    serverApplication = createServerApplication(composition, {
      acquireLock: async () => async () => {
        await instanceLock?.release();
        instanceLock = null;
      },
      recover: async () => undefined,
      markDraining: async () => {
        const current = await readEndpointManifest(endpointManifestPath);
        if (current) {
          await writeEndpointManifest(endpointManifestPath, {
            ...current,
            state: 'draining',
          });
        }
      },
      writeManifest: async endpoints => {
        const identity = await readReleaseIdentity(join(applicationRoot, 'release-identity.json'));
        await writeEndpointManifest(endpointManifestPath, {
          manifestVersion: 1,
          ...(identity ? { releaseId: identity.releaseId } : {}),
          serverVersion: process.env.METAWORK_VERSION ?? identity?.releaseId ?? 'development',
          gatewayProtocolVersion: 2,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          state: 'ready',
          unixSocketPath: endpoints.unixSocketPath,
          webOrigin: endpoints.webOrigin,
        });
      },
      removeManifest: () => removeEndpointManifest(endpointManifestPath),
    });
    await serverApplication.start();
    console.log(`MetaWork Server ready: ${gatewaySocketPath}`);
    await new Promise(() => undefined);
    return;
}
}

function encodeHistoryCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_cursor');
  return offset;
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : { value };
}
