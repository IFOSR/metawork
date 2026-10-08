import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { loadWindowsPrivateFiles } from '../platform/windows-private-files.js';
import { DesktopSessionService } from '../management/desktop-session.js';
import { ClientNotificationFeed, type ClientNotificationPage } from '../gateway/client-notification-feed.js';
import { KernelWorkflowRepo } from '../storage/kernel-workflow-repo.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { SqliteClientNavigationStore } from '../storage/client-navigation-repo.js';
import { SqlitePermissionRepository } from '../storage/permission-repo.js';
import { SqliteConversationActivityProjection } from '../storage/conversation-activity-projection-repo.js';
import { ConversationActivityProjector } from '../session/conversation-activity-projection.js';
// Server application entrypoint. Client launchers live in src/client and never
// construct the Runtime composition below.
import { dirname, join, resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { loadEnvFileIfExists } from '../utils/env-file.js';
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
import {
  ConfigurationService,
  ExecutorManualPreviewService,
} from '../configuration/index.js';
import type { ActivateDraftResult } from '../configuration/configuration-service.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import {
  buildApplicationConfig,
  createProductionConfigurationProbe,
  createProductionRuntimeBindings,
  createProductionSecretStore,
  createLegacyProductionSecretStore,
  resolvePlannerRuntimeEnvironment,
  importLocalAgentCredentials,
  importLocalAgentCredentialsForRefs,
  importLegacyProviderCredentials,
} from '../configuration/index.js';
import { prepareProductionSecretStore } from '../configuration/production-secret-store.js';
import {
  SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
  SPAN_ROUTING_SECRET_REFERENCE,
  SPAN_ROUTING_MODEL,
} from '../configuration/schema.js';
import { SpanRoutingAdvisor } from '../routing/span-routing-advisor.js';
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
import { resolveLocalEndpointPath } from '../platform/local-endpoint.js';
import { MarkdownPreviewServer } from '../integrations/markdown-preview.js';
import { FeishuRuntimeManager } from '../gateway/feishu-runtime.js';
import { FeishuGatewayAdapter } from '../gateway/feishu-gateway-adapter.js';
import { FeishuConversationRouting } from '../gateway/feishu-conversation-routing.js';
import { FeishuGatewaySessionPort } from '../gateway/feishu-gateway-session-port.js';
import { NotificationRoutingService, notificationFromTurn, type NotificationFact } from '../delivery/notification-routing.js';
import { SqliteNotificationRoutingStore } from '../storage/notification-routing-repo.js';
import { ClientActionReferences } from '../gateway/client-action-reference.js';
import { SqliteClientActionReferences } from '../storage/client-action-reference-repo.js';
import { GatewayAuditLog } from '../gateway/audit.js';
import { ClientGateway } from '../gateway/client-gateway.js';
import { BindingConversationResolver } from '../gateway/conversation-resolver.js';
import { ConversationBindingRepository } from '../session/conversation-binding-repository.js';
import { createAccountEventJournal } from './account-event-journal.js';
import { ConversationObservationService } from '../gateway/conversation-observation.js';
import { createConversationReadModel } from './conversation-read-model-composition.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';
import { SqliteConversationActivitySource } from '../storage/conversation-activity-source.js';
import type { ConversationActivityTask } from '../session/conversation-activity-source.js';
import { isTerminalTaskLifecycle, toTaskLifecycleState } from '../task/task-lifecycle.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import { GatewaySubscriptions } from '../gateway/gateway-subscriptions.js';
import { ConversationGatewayRuntime } from '../gateway/conversation-gateway-runtime.js';
import { FileCommandAdmissionStore } from '../gateway/command-admission-store.js';
import { SqliteCommandAdmissionStore } from '../storage/command-admission-repo.js';
import { WebGatewayAdapter } from '../management/web-gateway-adapter.js';
import { formatGatewayDoctorChecks, runGatewayDoctor } from '../gateway/doctor.js';
import { createRecoveryReplanner } from '../session/recovery-replanner.js';
import { planWithoutClient } from '../session/detached-recovery-planner.js';
import { ConversationSession } from '../session/conversation-session.js';
import { FileConversationStore } from '../session/file-conversation-store.js';
import { updateConversationCatalog } from '../session/conversation-catalog-mutation.js';
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
import { WorkspaceDirectoryBrowser } from '../management/workspace-directory-browser.js';
import {
  AgentInstallationReadinessService,
} from '../management/agent-installation-readiness-service.js';
import { WorkspaceGatewayRuntime } from '../gateway/workspace-gateway-runtime.js';
import { recordConversationInputTitle } from '../session/conversation-title.js';
import { workspaceEventStreamId } from '../gateway/workspace-event-stream.js';
import { clientConnectionEventStreamId } from '../gateway/client-connection-event-stream.js';
import { resolveServerWebPort } from './server-web-port.js';
import type { ConversationActivityProjection } from '../workspace/conversation-activity-projector.js';
import { WorkspaceDirectoryProjector } from '../workspace/workspace-directory-projector.js';
import { SqliteWorkspaceDirectoryProjectionRepo } from '../storage/workspace-directory-projection-repo.js';
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
import { buildPlannerConfigurationView, buildRuntimeConfigurationView, buildExecutorManualPreview } from '../configuration/projections.js';
import { validateEnabledModelPrices } from '../configuration/enabled-model-price-validation.js';
import { executorDraftSnapshot, projectExecutorManagement } from '../configuration/executor-configuration.js';
import { AutoModelResolver } from '../routing/auto-model-resolver.js';
import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import { projectTaskViewFacts } from '../gateway/task-view-facts.js';
import { projectTaskView } from '../task/task-view.js';
import { SqliteTaskActivityFacts } from '../storage/task-activity-facts-repo.js';
import { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import { RetryWakeRepo } from '../storage/retry-wake-repo.js';
import { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import {
  acquireInstanceLock,
  isInstanceRunning,
  stopInstanceForRestart,
  type InstanceLock,
} from '../management/lock.js';
import { formatWebAccessTokenLine } from '../management/token.js';
import { ManagementServer, type ConfigQuery, type ExecutionQuery } from '../management/server.js';
import { ArtifactPreviewService } from '../management/artifact-preview-service.js';
import { TaskArtifactRepo } from '../storage/task-artifact-repo.js';
import { ExecutionProjector } from '../management/execution-projector.js';
import {
  createGatewayReadOnlyQueryHandler,
  completeWorkspaceNavigationCommand,
} from '../gateway/read-only-query-handler.js';
import { GATEWAY_TASK_VIEW_QUERY_VERSION } from '../gateway/task-view.js';
import { WorkGraphPresentationProjector } from '../management/work-graph-presentation-projector.js';
import { WebAuthService } from '../management/web-auth.js';
import { WebLaunchContextService } from '../management/web-launch-context.js';
import { resolveLoginCredentials } from '../management/login-credentials.js';
import { FileConversationPresentationStore } from '../storage/file-conversation-presentation-store.js';
import { SqliteConversationHistoryRepo } from '../storage/conversation-history-repo.js';
import { SqliteConversationMetadataIndex } from '../storage/conversation-metadata-index-repo.js';
import { FileAttachmentStore } from '../storage/file-attachment-store.js';
import { WebSessionCatalog } from '../management/web-session-catalog.js';
import { WebGatewaySessionRuntime } from '../management/web-gateway-session-runtime.js';
import type { ManagementWebSessionRuntime } from '../management/web-session-runtime-types.js';
import {
  normalizeExecutionPresentation,
} from '../management/execution-presentation-normalizer.js';
import type { ConversationTurn } from '../management/web-session-types.js';
import type { ConversationTurn as CanonicalConversationTurn } from '../session/conversation-store.js';
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
import { knownModelCapabilities, MODEL_CAPABILITY_CATALOG } from '../configuration/model-capability-catalog.js';
import {
  buildProviderCompletionCatalog,
  discoverOpenAiCompatibleModels,
  fingerprintProviderCredential,
} from '../configuration/provider-model-discovery.js';
import { matchOpenRouterModel, OpenRouterModelCatalog } from '../configuration/openrouter-model-catalog.js';
import {
  loadInternalSettingsAssistantConfig,
} from '../configuration/internal-settings-assistant-config.js';
import { SettingsAssistant } from '../configuration/settings-assistant.js';
import { InternalLlmService } from '../configuration/internal-llm-service.js';
import { ModelRoutingProfileService } from '../configuration/model-routing-profile-service.js';
import { AgentCapabilityDescriptionService } from '../configuration/agent-capability-description.js';
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
import {
  billingModelPriceInputs,
  createServerBillingServices,
  resolveConfiguredUsagePayer,
} from './billing-composition.js';
import { createUsageRecorder } from '../metering/usage-service.js';
import { resolveTaskViewTurnAssociation } from '../gateway/task-view-association.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import { createBackgroundResultDelivery } from '../gateway/background-result-delivery.js';

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
  const providers: Record<string, SecretReference> = Object.fromEntries(
    LOCAL_AGENT_PROVIDER_REFS.map(providerRef => [
      providerRef,
      `file-secret:anyfusion/providers/${providerRef}` as SecretReference,
    ]),
  );
  await importLocalAgentCredentialsForRefs({
    ...localAgentCredentialSources(),
    providers,
    secretStore,
  });
}

/**
 * Applies SecretStore writes for one activation attempt and returns the
 * compensating action. Provider and Span credentials share this transaction so
 * any activation failure restores every touched reference together.
 */
async function stageSecretWrites(input: {
  secretStore: SecretStore;
  requireRecovery: () => void;
  writes: ReadonlyArray<{ reference: SecretReference; value: string }>;
}): Promise<() => Promise<void>> {
  const previous: Array<{ reference: SecretReference; value: string | null }> = [];
  const seen = new Set<string>();
  for (const write of input.writes) {
    if (seen.has(write.reference)) continue;
    seen.add(write.reference);
    let value: string | null = null;
    try {
      value = await input.secretStore.get(write.reference);
    } catch {
      value = null;
    }
    previous.push({ reference: write.reference, value });
  }
  try {
    for (const write of input.writes) {
      await input.secretStore.put(write.reference, write.value);
    }
  } catch (error) {
    try {
      await restoreSecretWrites(input.secretStore, previous);
    } catch (rollbackError) {
      input.requireRecovery();
      throw rollbackError;
    }
    throw error;
  }
  return async () => {
    await restoreSecretWrites(input.secretStore, previous);
  };
}

async function restoreSecretWrites(
  secretStore: SecretStore,
  previous: ReadonlyArray<{ reference: SecretReference; value: string | null }>,
): Promise<void> {
  for (const entry of previous) {
    if (entry.value === null) await secretStore.delete(entry.reference);
    else await secretStore.put(entry.reference, entry.value);
  }
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
  conversationGateway: { accountId: string; observation: ConversationObservationService; commands: WebGatewayAdapter };
  executionQuery: ExecutionQuery;
  configQuery: ConfigQuery;
  configurationRuntime?: {
    getState(): ReturnType<ConfigurationRuntimeCoordinator['getState']>;
    subscribe(listener: (event: unknown) => void): () => void;
  };
  attachmentStore?: FileAttachmentStore;
  artifactQuery: ArtifactPreviewService;
  webAuth: WebAuthService;
  desktopSessions?: DesktopSessionService;
  clientNotifications?: { read(cursor: string | null): ClientNotificationPage };
  serviceActivity?: () => { activeTasks: number; tasks: Array<{ id: string; title: string }>; truncated: boolean };
  launchContexts: WebLaunchContextService;
  agentReadiness: AgentInstallationReadinessService;
}): Promise<ManagementServer> {
  const loginCredentials = resolveLoginCredentials(process.env);
  if (loginCredentials.builtInDefault) {
    process.stdout.write(
      'MetaWork Web 正在使用内置登录凭据 admin / 123456；'
      + '请通过 ANYFUSION_WEB_USERNAME 与 ANYFUSION_WEB_PASSWORD(_HASH) 修改。\n',
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
    desktopSessions: options.desktopSessions,
    clientNotifications: options.clientNotifications,
    serviceActivity: options.serviceActivity,
    conversationGateway: options.conversationGateway,
    launchContexts: options.launchContexts,
    workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser(),
    runningRevisionId: options.runningRevisionId,
    sessionRuntime: options.sessionRuntime,
    executionQuery: options.executionQuery,
    configQuery: options.configQuery,
    configurationRuntime: options.configurationRuntime,
    loginCredentials,
    attachmentStore: options.attachmentStore,
    artifactQuery: options.artifactQuery,
    agentReadiness: options.agentReadiness,
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
  const candidateWindowsModule = join(applicationRoot, 'native/windows/metawork-platform.node');
  const windowsPipeModulePath = process.platform === 'win32' && existsSync(candidateWindowsModule)
    ? candidateWindowsModule : undefined;
  const windows = windowsPipeModulePath
    ? { root: paths.root, files: loadWindowsPrivateFiles(windowsPipeModulePath) } : undefined;
  // A Desktop release protects its installation before any mutable child is
  // created. Missing native support never enables Desktop tickets on net pipes.
  windows?.files.ensurePrivateDirectory(paths.root);

  // Surface secrets such as FEISHU_APP_SECRET live next to the install root
  // .env; load them before any gateway/platform wiring runs. Existing process
  // environment entries always win.
  loadEnvFileIfExists(join(paths.root, '.env'));
  const openRouterModelCatalog = new OpenRouterModelCatalog({
    cachePath: resolve(paths.root, 'metadata/openrouter-models.json'),
  });

  // Reconcile half-cancelled task state (orphaned dispatch items, stale
  // conversation slots, zombie schedule entries) at startup and every minute;
  // see docs/plans/2026-09-03-feishu-task-execution-incident-review.md.
  {
    const { runTaskStateReconciler } = await import('../execution/task-state-reconciler.js');
    const reconcileOnce = async () => {
      try {
        const report = await runTaskStateReconciler({ installRoot: paths.root });
        for (const line of report.lines) console.log(`[reconciler] ${line}`);
      } catch (error) {
        console.error(`[reconciler] reconciliation failed: ${(error as Error).message}`);
      }
    };
    await reconcileOnce();
    const timer = setInterval(() => { void reconcileOnce(); }, 60_000);
    timer.unref?.();
  }

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
    console.log(formatGatewayDoctorChecks(runGatewayDoctor({
      config,
      // ADR-0031: Gateway pairing and audit state live in the account root, not
      // at the installation root.
      gatewayDir: accountPaths.gateway,
    })));
    // Deep task-state diagnostics for the surfaces implicated by the
    // 2026-09-03 incident (dispatch queue, conversation slots, schedule
    // entries, blocked tasks).
    {
      const diagDb = createDatabase(accountPaths.database);
      try {
        const stuckDispatch = diagDb.prepare(
          "SELECT status, COUNT(*) AS count FROM kernel_dispatch_items WHERE status IN ('pending_launch', 'launching', 'cancelling', 'uncertain') GROUP BY status",
        ).all() as Array<{ status: string; count: number }>;
        const orphanDispatch = diagDb.prepare(
          "SELECT COUNT(*) AS count FROM kernel_dispatch_items AS item WHERE item.status IN ('pending_launch', 'launching', 'cancelling', 'uncertain') AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = item.task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived'))",
        ).get() as { count: number };
        const staleSlots = diagDb.prepare(
          "SELECT COUNT(*) AS count FROM conversation_task_slots WHERE active_task_id IS NOT NULL AND state IN ('occupied', 'releasing') AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = conversation_task_slots.active_task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived'))",
        ).get() as { count: number };
        const zombieSchedule = diagDb.prepare(
          "SELECT COUNT(*) AS count FROM task_schedule_entries AS entry WHERE entry.state IN ('queued', 'eligible', 'reserved', 'running') AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = entry.task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived'))",
        ).get() as { count: number };
        const blockedTasks = diagDb.prepare(
          "SELECT id, title FROM tasks WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 5",
        ).all() as Array<{ id: string; title: string }>;
        console.log(formatGatewayDoctorChecks([
          {
            name: 'tasks.dispatch_queue',
            status: stuckDispatch.length === 0 ? 'ok' : (orphanDispatch.count > 0 ? 'fail' : 'warn'),
            message: stuckDispatch.length === 0
              ? 'No in-flight dispatch items'
              : `${JSON.stringify(stuckDispatch)} in flight`
                + (orphanDispatch.count > 0 ? `; ${orphanDispatch.count} orphaned by terminal tasks (run: metawork maintenance reconcile-tasks)` : ''),
          },
          {
            name: 'tasks.conversation_slots',
            status: staleSlots.count > 0 ? 'fail' : 'ok',
            message: staleSlots.count > 0
              ? `${staleSlots.count} slot(s) held by terminal tasks; run: metawork maintenance reconcile-tasks`
              : 'No stale conversation slots',
          },
          {
            name: 'tasks.schedule_entries',
            status: zombieSchedule.count > 0 ? 'fail' : 'ok',
            message: zombieSchedule.count > 0
              ? `${zombieSchedule.count} zombie schedule entries; run: metawork maintenance reconcile-tasks`
              : 'No zombie schedule entries',
          },
          {
            name: 'tasks.blocked',
            status: blockedTasks.length > 0 ? 'warn' : 'ok',
            message: blockedTasks.length > 0
              ? blockedTasks.map(task => `${task.title} (${task.id.slice(0, 18)})`).join('; ')
              : 'No blocked tasks',
          },
        ]));
      } finally {
        diagDb.close();
      }
    }
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
    const legacySecretStore = createLegacyProductionSecretStore({
      secretsRoot: accountPaths.secrets,
      env: process.env,
      references: Object.values(activeSnapshot.config.providers)
        .map(provider => provider.apiKeyRef),
    });
    const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials, windows });
    await prepareProductionSecretStore(secretStore);
    await importLegacyProviderCredentials({
      target: secretStore,
      providers: activeSnapshot.config.providers,
      legacyStore: legacySecretStore,
    });
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
  if (cliCommand.kind === 'server') {
    const dataDir = paths.data;
    mkdirSync(dataDir, { recursive: true });
    instanceLock = await acquireInstanceLock(resolve(dataDir, 'runtime.lock'));
    process.once('exit', instanceLock.releaseOnExit);
  }

  // 2. Load the sole active configuration revision. Legacy *configuration
  // document* import belongs to the transactional installer rather than
  // ordinary runtime startup. The one exception is the Provider credential
  // cutover in step 3, which must also run ahead of the candidate probe inside
  // the upgrade transaction, because that probe runs before activation.
  // See configuration/provider-credential-migration.ts.

  // ADR-0031: 账户数据根——迁移并激活 local-default 账户，运行时使用账户作用域数据。
  await new AccountLayoutMigrator({ paths }).migrate();
  // Planner RPC runs from an account-owned directory. This keeps Server
  // startup independent of the shell directory and guarantees the cwd exists
  // before the first configuration or recovery turn.
  mkdirSync(accountPaths.workspaceStore, { recursive: true });

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
  const legacySecretStore = createLegacyProductionSecretStore({
    secretsRoot: accountPaths.secrets,
    env: process.env,
    references: Object.values(migratedSnapshot.config.providers)
      .map(provider => provider.apiKeyRef),
  });
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials, windows });
  await prepareProductionSecretStore(secretStore);
  await importLegacyProviderCredentials({
    target: secretStore,
    providers: migratedSnapshot.config.providers,
    legacyStore: legacySecretStore,
  });
  await preheatLocalAgentCredentials(secretStore);
  await importLocalAgentCredentials({
    ...localAgentCredentialSources(),
    providers: migratedSnapshot.config.providers,
    secretStore,
  });
  const internalLlmSecrets = createProductionSecretStore({
    credentialsFile: resolve(paths.root, 'internal/llm-credentials.json'),
    windows,
  });
  const internalLlm = new InternalLlmService({
    config: () => loadInternalSettingsAssistantConfig({ installRoot: paths.root }),
    secretStore: internalLlmSecrets,
  });
  const settingsAssistant = new SettingsAssistant(internalLlm);
  const modelRoutingProfiles = new ModelRoutingProfileService(internalLlm);
  const agentCapabilityDescriptions = new AgentCapabilityDescriptionService(internalLlm);
  const renderer = new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime'));
  // Refresh revision-scoped runtime artifacts on startup so existing active
  // revisions also receive newly introduced per-Executor manuals.
  await renderer.render(migratedSnapshot);
  const stagedConfiguration = buildStagedLegacyConfiguration({ migratedSnapshot });
  let accountRuntimeComposition: ReturnType<typeof buildAccountRuntimeComposition> | null = null;
  const configurationActivationGate = new ConfigurationActivationGate(() => (
    accountRuntimeComposition?.accountRuntime.getConfigurationActivationFacts() ?? {
      // 账户运行时尚未装配完成时失败关闭：启动恢复未确认前不允许配置写入。
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: true,
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
  const billingServices = createServerBillingServices(db, {
    configurationRevision: migratedSnapshot.revisionId,
    models: billingModelPriceInputs(Object.values(migratedSnapshot.config.models)),
  });
  const reconciledBillingCount = billingServices.reconcilePendingBills(
    LOCAL_DEFAULT_ACCOUNT_ID,
    new Date().toISOString(),
  );
  if (reconciledBillingCount > 0) {
    console.log(`[billing] reconciled ${reconciledBillingCount} pending bill(s) after startup`);
  }
  const usageRecorder = createUsageRecorder({ metering: billingServices.metering });
  const configuredUsagePayer = resolveConfiguredUsagePayer(process.env);
  if (billingServices.priceBookVersion === 'unconfigured') {
    console.warn(
      '[billing] no configured price book is active; new Query bills will remain 待确认 '
      + 'until Model Profile input/output prices are activated.',
    );
  }
  if (
    configuredUsagePayer === 'unknown'
    && process.env.METAWORK_BILLING_DEFAULT_PAYER?.trim() === 'unknown'
  ) {
    console.warn(
      '[billing] METAWORK_BILLING_DEFAULT_PAYER=unknown; usage will be recorded '
      + 'but formal fees will remain 待确认.',
    );
  }
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
  const directoryProjection = new SqliteWorkspaceDirectoryProjectionRepo(db, LOCAL_DEFAULT_ACCOUNT_ID);
  let directoryProjector: WorkspaceDirectoryProjector | null = null;
  const notificationStore = new SqliteNotificationRoutingStore(db);
  const clientNotifications = new ClientNotificationFeed();
  const conversationReadModel = createConversationReadModel(db);
  const conversationReadProjector = new ConversationReadProjector(conversationReadModel);
  const canonicalHistory = new SqliteConversationHistoryRepo<CanonicalConversationTurn>(db, LOCAL_DEFAULT_ACCOUNT_ID, 'conversation',
    (conversationId, turn, sequence) => conversationReadProjector.applyHistory(LOCAL_DEFAULT_ACCOUNT_ID, conversationId, turn, sequence));
  const presentationStore = new FileConversationPresentationStore(
    resolve(accountPaths.conversations, 'web-presentation'),
    new SqliteConversationHistoryRepo(db, LOCAL_DEFAULT_ACCOUNT_ID, 'presentation'),
  );
  const conversationStore = new FileConversationStore(
    resolve(accountPaths.conversations, 'gateway'),
    {
      onMetadataCommitted: metadata => directoryProjector?.observeMetadata(metadata),
      history: canonicalHistory,
      metadataIndex: new SqliteConversationMetadataIndex(db, LOCAL_DEFAULT_ACCOUNT_ID),
      readLegacyHistory: async conversationId => (await presentationStore.read(conversationId))?.turns.map(turn => ({
        id: turn.id, conversationId, userInput: turn.userInput,
        finalAnswer: turn.finalAnswer, status: turn.status,
      })) ?? [],
    },
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
  directoryProjector = new WorkspaceDirectoryProjector({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    projection: directoryProjection,
    readMetadata: async () => (await conversationStore.readCatalog()).conversations,
    getActivities: conversations => (
      accountRuntimeComposition?.accountRuntime.getConversationActivities(conversations) ?? new Map()
    ),
    onActivity: (conversationId, activity) => publishWorkspaceActivity(conversationId, activity),
  });
  const workspaceDirectory = new WorkspaceDirectoryService({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    workspaceCatalog: workspaceCatalogStore,
    conversationStore,
    projection: directoryProjection,
    authorize: (_path, principalId) => isAuthenticatedWorkspacePrincipalId(principalId),
    createConversationId: () => `conv_${nanoid(12)}`,
    getConversationActivities: conversations => (
      accountRuntimeComposition?.accountRuntime.getConversationActivities(conversations)
        ?? new Map()
    ),
    getConversationActivity: (conversationId, fallbackUpdatedAt) => (
      accountRuntimeComposition?.accountRuntime.getConversationActivity(
        conversationId,
        fallbackUpdatedAt,
      ) ?? {
        state: 'idle',
        taskId: null,
        updatedAt: fallbackUpdatedAt,
        latestTaskCreatedAt: fallbackUpdatedAt,
      }
    ),
  });
  const notifier = createNotificationService(config);
  const plannerHostSocketPath = (process.env.METACLAW_PLANNER_HOST_SOCKET
    ?? process.env.METACLAW_PLANNER_TUI_SOCKET
    ?? resolveLocalEndpointPath(metaclawDir, 'anyfusion-planner.sock')).trim();
  process.env.METACLAW_PLANNER_HOST_SOCKET = plannerHostSocketPath;
  process.env.METACLAW_PLANNER_TUI_SOCKET = plannerHostSocketPath;
  const plannerHost = new PlannerHostBridge({ socketPath: plannerHostSocketPath, logger: console });
  const plannerSupervisor = new PlannerProcessSupervisor({
    socketPath: plannerHostSocketPath,
    gatewaySocketPath,
    // Server startup is Workspace-neutral. Planner RPC still needs a cwd
    // inside its Runtime-authorized root, so use the account-owned runtime
    // workspace rather than the shell directory used to launch `metawork`.
    cwd: accountPaths.workspaceStore,
    authorizedWorkspace: accountPaths.workspaceStore,
    resolveAuthorizedWorkspace: async conversationId => {
      const metadata = await conversationStore.readMetadata(conversationId);
      const workspaceId = metadata?.workspaceBinding?.workspaceId;
      if (!workspaceId) return accountPaths.workspaceStore;
      const catalog = await workspaceCatalogStore.readCatalog();
      return catalog.workspaces.find(item => item.id === workspaceId && !item.archived)?.canonicalPath
        ?? accountPaths.workspaceStore;
    },
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
      const activeSnapshot = await configurationService.getSnapshot(context.configuration.revisionId);
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
          requiredCapabilities: inputProfile.requiredCapabilities,
          preferredCapabilities: [],
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
          configuration: buildRuntimeConfigurationView(activeSnapshot),
          plannerBinding,
          secretStore,
        }),
      };
    },
  });
  await plannerHost.start();
  const executorManualPreview = new ExecutorManualPreviewService(configurationService);

  // ADR-0031: 组合根构造 RuntimeRegistry + AccountRuntime（local-default），
  // 会话工厂复用 AccountRuntime 的账户级服务簇。
  const resolveTaskWorkspacePath = async (taskId: string): Promise<string | null> => {
    const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as
      { workspace_id: string | null } | undefined;
    if (!task?.workspace_id) return null;
    const workspace = await workspaceCatalogStore.findById(task.workspace_id);
    return workspace && workspace.availability === 'available' ? workspace.canonicalPath : null;
  };
  const webAttachmentStore = new FileAttachmentStore(
    resolve(accountPaths.conversations, 'web-attachments'),
    { accountId: LOCAL_DEFAULT_ACCOUNT_ID },
  );
  await webAttachmentStore.initialize();
  const pendingSystemDeliveries: Array<{ sessionId: string; delivery: ConversationResultDelivery }> = [];
  let deliverSystemResult: ((sessionId: string, delivery: ConversationResultDelivery, originTurnId?: string) => Promise<void>) | null = null;
  const spanRoutingShutdown = new AbortController();
  const spanRoutingAdvisor = new SpanRoutingAdvisor({
    resolveApiKey: async revisionId => {
      const snapshot = await configurationService.getSnapshot(revisionId);
      const span = snapshot.config.routing?.span;
      if (!span?.enabled || span.apiKeyRef !== SPAN_ROUTING_SECRET_REFERENCE) return null;
      try {
        return (await secretStore.get(SPAN_ROUTING_SECRET_REFERENCE as SecretReference)).trim() || null;
      } catch { return null; }
    },
    lifetimeSignal: spanRoutingShutdown.signal,
  });
  const recoveryReplan = createRecoveryReplanner({
    db,
    getPort: () => accountRuntimeComposition!.runtimePort,
    getSnapshot: revisionId => configurationService.getSnapshot(revisionId),
    evaluator: spanRoutingAdvisor,
    signal: spanRoutingShutdown.signal,
    plan: context => planWithoutClient({
      context, runner: plannerSupervisor, signal: spanRoutingShutdown.signal,
      registerSession: (id, session) => plannerHost.registerSession(id, session),
    }),
  });
  let conversationRegistry: ConversationRegistry | null = null;
  accountRuntimeComposition = buildAccountRuntimeComposition({
    recoveryReplan,
    resolveConfigurationSnapshot: revisionId => configurationService.getSnapshot(revisionId),
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    db,
    taskEngine,
    resolveWorkspacePath: resolveTaskWorkspacePath,
    memoryEngine,
    orchestration,
    contextRecaller,
    notifier,
    workspaceRoot: accountPaths.workspaceStore,
    attemptsRoot: accountPaths.attempts,
    resultsRoot: accountPaths.results,
    attachmentStore: webAttachmentStore,
    generatedRuntimeRoot: accountPaths.generatedAgentRuntime,
    sourceRoot: accountPaths.workspaceStore,
    resolveUserWorkspaceRoot: async conversationId => {
      const binding = (await conversationStore.readMetadata(conversationId))?.workspaceBinding;
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
    appendExecutionTrace: (conversationId, input) => {
      conversationRegistry?.getIfOpen(conversationId)?.appendExecutionTrace(input);
    },
    usageObserver: event => usageRecorder.record(event),
    usageSpanOpener: span => usageRecorder.openSpan(span),
    usageSpanCloser: (spanId, state, closedAt) => billingServices.metering.closeSpan(spanId, state, closedAt),
    usagePayer: configuredUsagePayer,
    queryUsageLifecycle: billingServices.lifecycle,
    onSystemResultDelivery: async (sessionId, delivery) => {
      if (deliverSystemResult) await deliverSystemResult(sessionId, delivery);
      else pendingSystemDeliveries.push({ sessionId, delivery });
    },
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
  let notificationTimer: ReturnType<typeof setInterval> | undefined;
  let notificationDrain: Promise<void> | null = null;
  let stopNotifications: (() => Promise<void>) | undefined;
  // 由稍后构造的 AgentInstallationReadinessService 填充：配置激活会改动
  // AgentClass 展示名，必须立刻重新投影并广播，否则就绪卡片会停在旧名字。
  let republishAgentReadiness: (() => void) | null = null;
  const configurationRuntimeCoordinator = new ConfigurationRuntimeCoordinator({
    service: configurationService,
    gate: configurationActivationGate,
    initialSnapshot: migratedSnapshot,
    validateActivationConfig: validateEnabledModelPrices,
    prepareConfig: ({ config, secrets, spanApiKey }) => {
      const prepared = structuredClone(config) as AnyFusionConfigurationV2;
      for (const [providerRef, apiKey] of Object.entries(secrets)) {
        const reference = `file-secret:anyfusion/providers/${providerRef}` as const;
        const provider = prepared.providers[providerRef];
        if (provider) provider.apiKeyRef = reference;
      }
      if (spanApiKey !== undefined) {
        // Only the credential reference is persisted. A later enable/disable
        // toggle reuses the same reference without re-entering the key.
        prepared.routing = {
          ...prepared.routing,
          span: {
            enabled: prepared.routing?.span?.enabled ?? false,
            model: SPAN_ROUTING_MODEL,
            timeoutMs: prepared.routing?.span?.timeoutMs ?? SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
            apiKeyRef: SPAN_ROUTING_SECRET_REFERENCE,
          },
        };
      }
      // Saving is deterministic: AI drafts were generated by InternalLlmService
      // on explicit settings actions. Never invoke the user-facing Planner here.
      return prepared;
    },
    stageSecrets: async ({ secrets, spanApiKey }) => {
      const writes: Array<{ reference: SecretReference; value: string }> = [];
      for (const [providerRef, apiKey] of Object.entries(secrets)) {
        writes.push({
          reference: `file-secret:anyfusion/providers/${providerRef}` as SecretReference,
          value: apiKey.trim(),
        });
      }
      if (spanApiKey !== undefined) {
        writes.push({
          reference: SPAN_ROUTING_SECRET_REFERENCE as SecretReference,
          value: spanApiKey.trim(),
        });
      }
      return stageSecretWrites({
        secretStore,
        requireRecovery: () => configurationActivationGate.requireRecovery(),
        writes,
      });
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
      billingServices.refreshConfiguration({
        configurationRevision: snapshot.revisionId,
        models: billingModelPriceInputs(Object.values(snapshot.config.models)),
      });
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
      republishAgentReadiness?.();
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
      billingServices.refreshConfiguration({
        configurationRevision: snapshot.revisionId,
        models: billingModelPriceInputs(Object.values(snapshot.config.models)),
      });
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
      republishAgentReadiness?.();
    },
  });
  const agentReadiness = new AgentInstallationReadinessService({
    requiredAgentIds: () => {
      const config = configurationRuntimeCoordinator.getSnapshot().config;
      return [...new Set(Object.values(config.agentClasses)
        .filter(agent => agent.kind === 'executor' && agent.enabled)
        .flatMap(agent => {
          const driver = config.harnesses[agent.harnessRef]?.driverId;
          return driver === 'pi-cli' ? ['pi-agent' as const]
            : driver === 'codex-cli' ? ['codex-cli' as const] : [];
        }))];
    },
    // Installation belongs to the shared tool, not one arbitrarily chosen assistant.
    resolveDisplayName: agentId => agentId === 'pi-agent' ? 'Pi' : 'Codex CLI',
  });
  republishAgentReadiness = () => agentReadiness.republish();
  const runtimePort = activatedAccountRuntime.getConversationPort();
  conversationRegistry = new ConversationRegistry();


  // ADR-0031: 直接构造 ConversationSession（不经过 MetaclawSession 桥接），
  // 会话级 callbacks + 账户级 Kernel 执行服务后置绑定。
  const buildConversationSession = async (conversationId: string): Promise<ConversationSession> => {
    const existingMetadata = await conversationStore.readMetadata(conversationId);
    if (!existingMetadata) {
      const now = new Date().toISOString();
      const record = {
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
      const metadata = record.conversation;
      await updateConversationCatalog(conversationStore, catalog => ({
        ...catalog,
        conversations: [
          ...catalog.conversations.filter(item => item.id !== conversationId),
          metadata,
        ],
      }));
    }
    const port = runtimePort;
    const persistenceService = new SessionPersistenceService(db);
    const presentation = new SessionPresentationService();
    const sessionStateRepo = new SessionStateRepo(db);
    const interactionTraceStream = new InteractionTraceStream(conversationId);
    const planningContextBuilder = new PlanningContextBuilder({
      sessionId: conversationId,
      conversationId,
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
      onBackgroundResultDelivery: async (delivery, originTurnId) => {
        if (!deliverSystemResult) throw new Error('Result delivery is unavailable');
        await deliverSystemResult(conversationId, delivery, originTurnId);
      },
      conversationId,
      plannerSessionId: conversationId,
      plannerBindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
      plannerProviderRef: stagedConfiguration.plannerBinding.providerRef,
      plannerModelId: plannerModel.modelId,
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
      resolveConfigurationSnapshot: revisionId => configurationService.getSnapshot(revisionId),
      spanRoutingEvaluator: spanRoutingAdvisor,
      lifetimeSignal: spanRoutingShutdown.signal,
      commandCatalog,
      commandReadServices,
      taskEngine,
      memoryEngine,
      orchestration,
      config,
      plannerProposalRepo: new PlannerProposalRepo(db),
      queryUsage: {
        lifecycle: billingServices.lifecycle,
        externalAccountRef: billingServices.externalAccountRef,
        priceBookVersion: billingServices.priceBookVersion,
        feePolicyVersion: billingServices.feePolicyVersion,
        getPriceBookVersion: () => billingServices.priceBookVersion,
        getFeePolicyVersion: () => billingServices.feePolicyVersion,
        payerPolicyVersion: billingServices.payerPolicyVersion,
        ingress: 'tui',
        usageObserver: event => usageRecorder.record(event),
        usagePayer: configuredUsagePayer,
      },
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
  const eventJournalRuntime = createAccountEventJournal({
    historyWorkerUrl: new URL('./conversation-history-worker.js', import.meta.url),
    prepareHistory: async conversationId => {
      if (!canonicalHistory.isImported(conversationId)
        && new SqliteConversationMetadataIndex(db, LOCAL_DEFAULT_ACCOUNT_ID).find(conversationId)) {
        await conversationStore.readHistoryPage(conversationId, { limit: 1 });
      }
    },
    readModel: conversationReadModel,
    db, root: resolve(accountPaths.gateway, 'events'), accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    onError: error => console.error(`Gateway journal maintenance failed: ${(error as Error).message}`),
  });
  const eventJournal = eventJournalRuntime.journal;
  const normalizeHistoryPage = (turns: readonly ConversationTurn[]): ConversationTurn[] => {
    const taskIds = [...new Set(turns.flatMap(turn => turn.taskId ? [turn.taskId] : []))];
    const aliases = new Map(new KernelDecisionRepo(db).listPresentationIdentitiesByTasks(taskIds)
      .map(plan => [plan.taskId, buildCanonicalSubtaskIdentityMap(
        plan.taskId, plan.graphRevision, plan.subtaskIds.map(id => ({ id })),
      )]));
    return turns.map(turn => normalizeExecutionPresentation(turn, aliases.get(turn.taskId ?? '') ?? new Map()));
  };
  const normalizeTurnPresentation = (turn: ConversationTurn): ConversationTurn => normalizeHistoryPage([turn])[0]!;
  const webSessionCatalog = new WebSessionCatalog({
    directory: workspaceDirectory,
    conversationStore,
    presentationStore,
    normalizeTurnPresentation,
    normalizeHistoryPage,
  });
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
      if (await conversationStore.readMetadata(conversationId)) return true;
      const owned = durableConversation.get(
        conversationId,
        conversationId,
        conversationId,
        conversationId,
        conversationId,
      ) as { owned: number } | undefined;
      if (owned) return true;
      return await eventJournal.lastSequence(accountId, conversationId) > 0;
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
  const projectObservedTask = (
    task: ConversationActivityTask,
    permissionRequestId: string | null,
    result: import('../task/task-view.js').TaskViewResultFact | null = null,
  ) => {
    const taskId = task.id;
    return projectTaskView({
        task: { id: task.id, status: task.status, updatedAt: task.updatedAt },
        subtasks: new SubtaskRepo(db).listByTask(taskId)
          .map(subtask => ({ id: subtask.id, status: subtask.status })),
        dispatches: new KernelDispatchItemRepo(db).listByTask(taskId).map(item => ({
          attemptId: item.attemptId,
          subtaskId: item.subtaskId,
          status: item.status,
          attemptKind: item.attemptKind,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        receipts: new ExecutorAttemptReceiptRepo(db).listByTask(taskId).map(receipt => ({
          attemptId: receipt.attemptId,
          terminalState: receipt.terminalState,
          failure: receipt.failure,
          completedAt: receipt.completedAt,
        })),
        replanJobs: new GenerationReplanRequestRepo(db).listByTask(taskId).map(job => ({
          id: job.id,
          status: job.status,
          generationId: job.generationId,
          sourceRevision: job.sourceRevision,
          updatedAt: job.updatedAt,
        })),
        uncertainApplications: accountRuntimeComposition.runtimePort.queries
          .listRecoveryApplications(taskId)
          .filter(item => item.status === 'uncertain')
          .map(item => ({
            applicationId: item.decisionId,
            action: item.decision.action.type,
            errorSummary: item.errorSummary,
            updatedAt: item.updatedAt,
          })),
        publications: new WorkspacePublicationRepo(db).listByTask(taskId)
          .map(publication => ({ id: publication.id, status: publication.status })),
        completionResidue: accountRuntimeComposition.runtimePort.queries
          .listCompletionResidue(taskId),
        pendingPermission: permissionRequestId ? { requestId: permissionRequestId } : null,
        retryWakeAt: new RetryWakeRepo(db)
          .findBlockingByTask(taskId)
          .map(wake => wake.resumeAt)
          .sort()
          .at(-1) ?? null,
        retryWakeRecoveryRequired: new RetryWakeRepo(db)
          .findRecoveryRequiredByTask(taskId)
          .length > 0,
        result,
      });
  };
  const permissionNotificationPage = (taskId: string, afterId = '') => {
    const task = taskRepo.findById(taskId);
    if (!task?.accountId || !task.conversationId) return { facts: [], nextId: null };
    const turn = conversationReadModel.findTaskTurn(task.accountId, task.conversationId, taskId);
    const requests = new SqlitePermissionRepository(db).listEscalatedForTask(taskId, afterId, 17);
    const facts: NotificationFact[] = requests.slice(0, 16).filter(record =>
      Date.parse(record.createdAt) + 24 * 60 * 60 * 1000 > Date.now()).map(record => {
      const request = record.request;
      const resource = redactSensitiveText(request.resource);
      const reason = redactSensitiveText(request.reason);
      return { accountId: task.accountId!, conversationId: task.conversationId!, taskId, requestId: turn?.requestId ?? null,
        subjectId: request.id, category: 'approval', version: request.fingerprint,
        payload: { requestId: request.id, requestRevision: request.fingerprint, taskId, generationId: request.generationId,
          operation: request.operation.slice(0, 256), resource: resource.slice(0, 512), reason: reason.slice(0, 512), scope: request.suggestedScope,
          ...(resource.length > 512 || reason.length > 512 || request.operation.length > 256 ? {
            detailsRef: conversationReadModel.putContent(task.accountId!, task.conversationId!,
              JSON.stringify({ resource, reason, operation: request.operation, scope: request.suggestedScope })),
          } : {}),
        } };
    });
    return { facts, nextId: requests.length > 16 ? requests[15]!.request.id : null };
  };
  const activityProjection = new SqliteConversationActivityProjection(db, (taskId, summary) => {
    const task = taskRepo.findById(taskId);
    if (!task?.accountId || !task.conversationId) return;
    const turn = conversationReadModel.findTaskTurn(task.accountId, task.conversationId, task.id);
    const scope = { accountId: task.accountId, conversationId: task.conversationId, taskId,
      requestId: turn?.requestId ?? null };
    notificationStore.capture({ ...scope, subjectId: taskId, category: 'progress',
      version: createHash('sha256').update(JSON.stringify(summary)).digest('hex'), payload: summary }, Date.now());
    notificationStore.schedulePermissions(taskId);
    // Run after the projection transaction. Confirm its committed value before issuing a UI hint.
    queueMicrotask(() => {
      if (!db.open || JSON.stringify(activityProjection.read(taskId)) !== JSON.stringify(summary)) return;
      const kind = summary.phase === 'completed' ? 'completed' : summary.phase === 'failed' ? 'failed'
        : summary.phase === 'waiting_for_user' ? 'approval' : null;
      if (!kind || !task.workspaceId) return;
      clientNotifications.publish(task.accountId!, {
        workspaceId: task.workspaceId, conversationId: task.conversationId!, taskId,
        ...(turn ? { turnId: turn.id } : {}), kind,
      }, `${summary.executionGeneration}:${kind === 'approval'
        ? new SqlitePermissionRepository(db).findPendingForTask(taskId)?.request.fingerprint ?? 'pending' : kind}`);
    });
  });
  const activityProjector = new ConversationActivityProjector(activityProjection, task => {
    const pending = new SqlitePermissionRepository(db).findPendingForTask(task.id);
    const permissionId = pending && !new KernelWorkflowRepo(db).findPermissionResolution(pending.request.id) ? pending.request.id : null;
    const view = projectTaskView(new SqliteTaskActivityFacts(db).read(task,
      permissionId ? { requestId: permissionId } : null));
    const generation = accountRuntimeComposition.runtimePort.queries.findActiveWorkGraphRevision(task.id)?.generationId ?? `unplanned:${task.id}`;
    const progress = new SqliteConversationActivitySource(db).latestProgress(task.id, generation);
    return { taskId: task.id, title: task.title,
      executionGeneration: generation,
      ...(progress ? { progressSummary: redactSensitiveText(progress).slice(0, 1024) } : {}),
      phase: view.phase, explanation: view.explanation, canCancel: !isTerminalTaskLifecycle(view.lifecycle) };
  });
  const activityProjectionTimer = setInterval(() => {
    try {
      notificationStore.scanPermissions(permissionNotificationPage, Date.now());
      const started = performance.now();
      for (let count = 0; count < 4 && performance.now() - started < 20; count++) {
        if (!activityProjector.maintain()) break;
      }
    } catch (error) { console.error(`Task activity projection: ${(error as Error).message}`); }
  }, 100);
  activityProjectionTimer.unref();
  const conversationObservation = new ConversationObservationService({
    identity: { serverId: conversationReadModel.serverIdentity(), accountId: LOCAL_DEFAULT_ACCOUNT_ID },
    metadata: async (_accountId, conversationId) => {
      const metadata = await conversationStore.readMetadata(conversationId);
      const workspace = metadata?.workspaceBinding?.workspaceId
        ? await workspaceCatalogStore.findById(metadata.workspaceBinding.workspaceId) : null;
      return metadata ? { id: metadata.id, workspaceId: metadata.workspaceBinding?.workspaceId ?? null, title: metadata.title,
        ...(workspace ? { workspace: { id: workspace.id, path: workspace.canonicalPath,
          displayName: workspace.displayName, availability: workspace.availability } } : {}) } : null;
    },
    model: eventJournalRuntime.readModel,
    search: eventJournalRuntime.search,
    subscriptions: gatewaySubscriptions,
    sourceSequence: eventJournalRuntime.sourceSequence,
    activity: async (accountId, conversationId, cursor, pendingCursor) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) throw new Error('account_denied');
      const metadata = await conversationStore.readMetadata(conversationId);
      if (!metadata || metadata.accountId !== accountId) throw new Error('conversation_denied');
      const requests = accountRuntimeComposition.runtimePort.permissions?.listForSession(metadata.plannerSessionId, pendingCursor ?? '', 9) ?? [];
      const page = new SqliteConversationActivitySource(db).page(accountId, conversationId, cursor);
      return {
        tasks: page.tasks.map(task => activityProjection.read(task.id) ?? {
          taskId: task.id, title: task.title, executionGeneration: '',
          phase: 'preparing', explanation: '正在同步任务进度…', canCancel: false,
        }),
        nextCursor: page.nextCursor,
        pendingNextCursor: requests.length > 8 ? requests[7]!.permissionRequestId : null,
        pendingInteractions: requests.slice(0, 8).map(request => ({ requestId: request.permissionRequestId, requestRevision: request.requestRevision,
          taskId: request.taskId, generationId: request.generationId, subtaskId: request.subtaskId, attemptId: request.attemptId,
          resource: redactSensitiveText(request.resource).slice(0, 512), operation: request.operation.slice(0, 256), reason: redactSensitiveText(request.reason).slice(0, 512),
          ...(request.resource.length > 512 || request.reason.length > 512 ? { detailsRef: eventJournalRuntime.readModel.putContent(accountId, conversationId,
            redactSensitiveText(JSON.stringify({ resource: request.resource, operation: request.operation, reason: request.reason, scope: request.suggestedScope }))) } : {}),
          capability: request.capability, scope: request.suggestedScope, expiresAt: request.expiresAt })),
      };
    },
    authorize: async (accountId, conversationId) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return false;
      const metadata = await conversationStore.readMetadata(conversationId);
      return metadata?.accountId === accountId && !metadata.archived
        && Boolean(await workspaceDirectory.resolveConversationWorkspace(conversationId, 'local:local-installation'));
    },
    onError: error => console.error(`Conversation observation failed: ${(error as Error).message}`),
  });
  // ExecutionProjector / TaskArtifactRepo 同时服务 Web 管理面与 Gateway 只读
  // Task 视图查询（统一 TUI 设计 §9.3）：同一投影 owner，不复制状态计算。
  const taskArtifactRepo = new TaskArtifactRepo(db);
  const timelineConfigurationByRevision = new Map<string, Awaited<ReturnType<typeof configurationRepository.readSnapshot>>>();
  for (const revisionId of await configurationRepository.listRevisions()) {
    try {
      timelineConfigurationByRevision.set(
        revisionId,
        await configurationRepository.readSnapshot(revisionId),
      );
    } catch {
      // A removed/corrupt historical revision must remain visible as
      // unavailable in the Timeline; it must never be replaced by today's
      // configuration and thereby rewrite history.
    }
  }
  const executionProjector = new ExecutionProjector({
    subtaskRepo: new SubtaskRepo(db),
    receiptRepo: new ExecutorAttemptReceiptRepo(db),
    decisionRepo: new KernelDecisionRepo(db),
    publicationRepo: new WorkspacePublicationRepo(db),
    attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db),
    dispatchItemRepo: new KernelDispatchItemRepo(db),
    configurationByRevision: timelineConfigurationByRevision,
  });
  const conversationGatewayRuntime = new ConversationGatewayRuntime({
    storeResultContent: (accountId, conversationId, content) => {
      eventJournalRuntime.readModel.putContent(accountId, conversationId, content);
    },
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    registry: accountRegistry,
    conversations: conversationRegistry,
    conversationFactory: buildConversationSession,
    journal: eventJournal,
    subscriptions: gatewaySubscriptions,
    attachments: webAttachmentStore,
    recordInputTitle: async (conversationId, input) => {
      await recordConversationInputTitle(conversationStore, conversationId, input);
      const summary = directoryProjection.find(conversationId);
      if (summary) await workspaceGatewayRuntime.publishConversation(summary);
    },
    readHistory: async (conversationId, cursor, requestedLimit) => {
      const page = await conversationStore.readHistoryPage(conversationId, {
        cursor: cursor === 'newest' ? undefined : cursor, limit: requestedLimit, maxBytes: 256 * 1024,
      });
      return {
        turns: [...page.turns].reverse(),
        previousCursor: cursor ? 'newest' : null,
        nextCursor: page.nextCursor,
      };
    },
  });
  const deliveryResults = new ResultObjectRepo(db, accountPaths.results);
  const deliveryScheduler = new ConversationTaskSchedulerRepo(db);
  deliverSystemResult = createBackgroundResultDelivery({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    resolveTask: resultId => {
      const object = deliveryResults.findObject(resultId);
      return object?.accountId === LOCAL_DEFAULT_ACCOUNT_ID && object.kind !== 'raw_attempt_output'
        ? taskRepo.findById(object.taskId) : null;
    },
    resolveQuery: taskId => {
      const queryId = deliveryScheduler.getQueuedPayload(taskId)?.queryId
        ?? billingServices.contexts.listQueryIdsForTask(taskId)[0];
      return queryId ? billingServices.contexts.findById(queryId) : null;
    },
    taskForQuery: queryId => billingServices.contexts.findTaskLink(queryId)?.costTaskId ?? null,
    read: conversationId => webSessionCatalog.read(conversationId),
    requestText: taskId => deliveryScheduler.getQueuedPayload(taskId)?.requestText ?? null,
    project: task => executionProjector.project(task),
    append: (conversationId, turn) => webSessionCatalog.appendTurn(conversationId, turn),
    replay: conversationId => eventJournal.replay(LOCAL_DEFAULT_ACCOUNT_ID, conversationId),
    publish: input => conversationGatewayRuntime.publishBackgroundResult(input),
  });
  for (const pending of pendingSystemDeliveries.splice(0)) {
    await deliverSystemResult(pending.sessionId, pending.delivery);
  }
  // Older system bindings discarded the presentation callback. Recover only
  // safe result objects of completed queued Tasks, never raw attempt output.
  for (const task of taskRepo.findByStatus('done')) {
    const queued = deliveryScheduler.getQueuedPayload(task.id);
    if (!task.conversationId || !queued?.queryId
      || !['account_task_capacity', 'conversation_slot_occupied'].includes(queued.schedulingReason ?? '')) continue;
    if (new SubtaskRepo(db).listByTask(task.id).length !== 1) continue;
    const receipt = new ExecutorAttemptReceiptRepo(db).listByTask(task.id)
      .find(item => item.terminalState === 'completed');
    const resultId = asPayloadRecord(receipt?.parsing.resultObjects).safeProjectionId;
    if (typeof resultId !== 'string') continue;
    const object = deliveryResults.findObject(resultId);
    if (!object || object.kind !== 'safe_projection' || object.byteLength === 0
      || object.accountId !== task.accountId || object.taskId !== task.id) continue;
    await deliverSystemResult(task.conversationId, {
      resultId, content: deliveryResults.readRange(resultId, 0, object.byteLength).content,
      completeness: object.completeness, certification: 'certified',
    });
  }
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
      const streamId = clientConnectionEventStreamId(connectionId);
      const sequence = await eventJournal.reserveSequence(LOCAL_DEFAULT_ACCOUNT_ID, streamId);
      gatewaySubscriptions.publish({
        protocolVersion: 2,
        eventId: `event_${nanoid(12)}`,
        sequence,
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        conversationId: streamId,
        requestId: requestId ?? null,
        turnId: null,
        kind,
        payload: asPayloadRecord(payload),
        occurredAt: new Date().toISOString(),
      });
    },
  });
  publishWorkspaceActivity = async (conversationId, activity) => {
    directoryProjector!.observeActivity(conversationId, activity);
    const binding = (await conversationStore.readMetadata(conversationId))?.workspaceBinding;
    if (!binding) return;
    await workspaceGatewayRuntime.publishActivity(binding.workspaceId, {
      conversationId,
      activity,
    });
  };
  const gatewayReadOnlyQueryHandler = createGatewayReadOnlyQueryHandler({
    subscriptions: gatewaySubscriptions,
    journal: eventJournal,
    billing: billingServices.queries,
    authorizeTask: (accountId, taskId) => {
      const task = taskRepo.findById(taskId);
      return Boolean(task && task.accountId === accountId);
    },
    authorizeConversation: authorizeConversationAttach,
    conversationResource: async (accountId, command) => {
      const id = command.conversationId;
      if (command.resource === 'turns') return conversationObservation.page(accountId, id, command.cursor, 60 * 1024, command.beforeTurnId);
      if (command.resource === 'activity') return conversationObservation.activity(accountId, id, command.cursor, command.pendingCursor);
      if (command.resource === 'metadata') return conversationObservation.metadata(accountId, id);
      if (command.resource === 'locate') return conversationObservation.locate(accountId, id, '', command.taskId, 40 * 1024);
      if (command.resource === 'content') return conversationObservation.content(accountId, id, command.hash!, command.offset!, 8 * 1024);
      await conversationObservation.metadata(accountId, id);
      return eventJournal.readTracePage?.(accountId, id, command.turnId!, command.cursor, 10)
        ?? { events: [], nextCursor: null, preparing: true };
    },
    pendingInteractions: async (accountId, conversationId, cursor, limit) => {
      const metadata = await conversationStore.readMetadata(conversationId);
      if (!metadata || metadata.accountId !== accountId) throw new Error('conversation_denied');
      return accountRuntimeComposition.runtimePort.permissions?.listForSession(metadata.plannerSessionId, cursor, limit) ?? [];
    },
    completeCommand: ({ scope, text, cursor }) => {
      if (scope.kind === 'workspace') {
        return completeWorkspaceNavigationCommand(text, cursor);
      }
      // Conversation scope 必须显式 attach；会话未打开时 fail closed，
      // 不为补全隐式启动 Planner 或创建绑定。
      if (scope.selection.mode !== 'attach') {
        return { state: 'inactive', suggestions: [], hint: null, error: null };
      }
      const conversation = conversationRegistry.getIfOpen(scope.selection.conversationId);
      if (!conversation) {
        return { state: 'inactive', suggestions: [], hint: null, error: null };
      }
      return conversation.completeCommand(text, cursor);
    },
    getTaskView: async ({ accountId, conversationId, turnId, taskId, requestId }) => {
      if (accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return { error: 'task_view_unavailable' };
      // Card refreshes use the small indexed Turn, never deserialize its legacy
      // aggregate transcript just to establish Task identity or timestamps.
      const observedTurn = conversationReadModel.findTurn(accountId, conversationId, turnId);
      const recordedTurn = observedTurn ?? await webSessionCatalog.readTurn(conversationId, turnId);
      const liveTrace = conversationRegistry.getIfOpen(conversationId)?.getInteractionTrace() ?? null;
      const liveTurn = liveTrace && liveTrace.turnId === turnId ? liveTrace : null;
      const traceRead = await eventJournal.readTurnTaskObservation(accountId, conversationId, turnId);
      const queryContext = billingServices.contexts.findByTurnId(accountId, turnId);
      const queryTaskId = queryContext?.conversationId === conversationId
        ? billingServices.contexts.findTaskLink(queryContext.queryId)?.costTaskId ?? null
        : null;
      const association = resolveTaskViewTurnAssociation({
        accountId,
        conversationId,
        turnId,
        taskId,
        traceObservation: traceRead.observation,
        queryTaskId,
        liveTaskId: liveTurn?.taskId,
        presentationTaskId: recordedTurn?.taskId,
      });
      if (association.status === 'not_found') {
        return { error: 'turn_not_found' };
      }
      const recordedTaskId = recordedTurn?.taskId ?? null;
      if (association.status === 'mismatch' || (recordedTaskId && recordedTaskId !== taskId)) {
        return { error: 'turn_task_mismatch' };
      }
      const task = taskRepo.findById(taskId);
      if (!task || task.accountId !== accountId || task.conversationId !== conversationId) {
        return { error: 'task_not_found' };
      }
      const pendingPermission = accountRegistry.getIfLoaded(accountId)
        ?.getConversationPort().queries.findOldestPendingPermission(conversationId) ?? null;
      const taskPermission = pendingPermission && pendingPermission.request.taskId === taskId
        ? pendingPermission
        : null;
      const associationProgressSummary = association.status === 'matched'
        ? association.progressSummary
        : null;
      const progressSummary = liveTurn?.events.at(-1)?.summary
        ?? (recordedTurn && 'traceEvents' in recordedTurn ? recordedTurn.traceEvents.at(-1)?.summary : null)
        ?? associationProgressSummary
        ?? null;
      const executionFacts = await projectTaskViewFacts({
        task,
        subtasks: new SubtaskRepo(db).listByTask(taskId),
        dispatches: new KernelDispatchItemRepo(db).listByTask(taskId),
        receipts: new ExecutorAttemptReceiptRepo(db).listByTask(taskId),
        findObject: resultId => deliveryResults.findObject(resultId),
        readConfiguration: revisionId => configurationRepository.readSnapshot(revisionId),
      });
      const lifecycleProjection = projectObservedTask(task, taskPermission?.request.id ?? null, executionFacts.result);
      const timeline = executionProjector.project(task);
      const publicExecutors = new Map(executionFacts.subtasks.map(subtask => [subtask.id, subtask.executor]));
      for (const stage of timeline.stages) {
        for (const subtask of stage.subtasks ?? []) {
          subtask.executor = publicExecutors.get(subtask.id) ?? undefined;
        }
      }
      return {
        queryVersion: GATEWAY_TASK_VIEW_QUERY_VERSION,
        requestId,
        targetConversationId: conversationId,
        turnId,
        taskId,
        title: task.title,
        status: timeline.status,
        lifecycle: {
          lifecycle: lifecycleProjection.lifecycle,
          phase: lifecycleProjection.phase,
          activeAttempt: lifecycleProjection.activeAttempt
            ? {
                attemptId: lifecycleProjection.activeAttempt.attemptId,
                subtaskId: lifecycleProjection.activeAttempt.subtaskId,
                kind: lifecycleProjection.activeAttempt.attemptKind,
                ordinal: lifecycleProjection.activeAttempt.ordinal,
                lifecycle: lifecycleProjection.activeAttempt.lifecycle,
                outcome: lifecycleProjection.activeAttempt.outcome,
              }
            : null,
          blockingResidue: lifecycleProjection.blockingResidue,
          nextAuthorizedAction: lifecycleProjection.nextAuthorizedAction,
          recoveryDiagnosis: lifecycleProjection.recoveryDiagnosis,
          explanation: lifecycleProjection.explanation,
          lastProgressAt: lifecycleProjection.timestamps.lastProgressAt,
          lastAttemptSettledAt: lifecycleProjection.timestamps.lastAttemptSettledAt,
          nextWakeAt: lifecycleProjection.timestamps.nextWakeAt,
        },
        goal: task.goal ? task.goal.slice(0, 2_000) : null,
        startedAt: recordedTurn?.startedAt ?? liveTurn?.startedAt
          ?? (association.status === 'matched' ? association.startedAt : null),
        completedAt: recordedTurn?.completedAt ?? liveTurn?.completedAt
          ?? (association.status === 'matched' ? association.completedAt : null),
        routing: executionFacts.routing,
        subtasks: executionFacts.subtasks,
        timeline,
        progressSummary: progressSummary ? progressSummary.slice(0, 500) : null,
        schedulingReason: accountRuntimeComposition.runtimePort.queries.getQueuedTaskReason(taskId),
        pendingPermission: taskPermission
          ? {
              requestId: taskPermission.request.id,
              status: 'pending',
              summary: `${taskPermission.request.operation} ${taskPermission.request.resource}`
                .trim().slice(0, 200) || null,
            }
          : null,
        artifacts: taskArtifactRepo.listByTask(taskId)
          .filter(artifact => (
            artifact.accountId === LOCAL_DEFAULT_ACCOUNT_ID
            && artifact.status === 'published'
          ))
          .map(artifact => taskArtifactRepo.toProjection(artifact)),
        result: executionFacts.result,
        asOfSequence: traceRead.lastSequence,
      };
    },
  });
  const commandAdmissionStore = new SqliteCommandAdmissionStore(db, LOCAL_DEFAULT_ACCOUNT_ID);
  await commandAdmissionStore.initialize(new FileCommandAdmissionStore(
    resolve(accountPaths.gateway, 'command-admissions'),
  ));
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
    commandAdmissionStore,
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
    handleReadOnlyQuery: (command, context) => gatewayReadOnlyQueryHandler(command, context),
    newWorkAdmission: {
      check: command => {
        if (command.kind === 'create_conversation') return { allowed: true };
        if (!Object.values(configurationRuntimeCoordinator.getSnapshot().config.agentClasses)
          .some(agent => agent.kind === 'executor' && agent.enabled)) {
          return { allowed: false, reason: 'no_enabled_executor' };
        }
        const missing = agentReadiness.getState().find(agent => agent.required && agent.status !== 'installed');
        if (missing) return { allowed: false, reason: 'required_agent_unavailable', agentId: missing.agentId };
        const priceIssues = validateEnabledModelPrices(configurationRuntimeCoordinator.getSnapshot().config);
        return priceIssues.length > 0
          ? { allowed: false, reason: 'configuration_invalid' }
          : { allowed: true };
      },
    },
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
  const webAuth = new WebAuthService();
  const desktopInstanceId = randomUUID();
  const desktopInstallationId = createHash('sha256').update(await realpath(paths.root)).digest('hex');
  const desktopRelease = await readReleaseIdentity(join(applicationRoot, 'release-identity.json'));
  let desktopReady = false;
  const desktopSessions = new DesktopSessionService(() => desktopReady && managementServer ? {
    installationId: desktopInstallationId, instanceId: desktopInstanceId,
    accountId: LOCAL_DEFAULT_ACCOUNT_ID, releaseId: desktopRelease?.releaseId ?? 'development',
    pid: process.pid, webOrigin: managementServer.address, gatewayProtocolVersion: 2,
  } : null);


  const gatewayServer = new MetaclawGatewayServer({
    socketPath: gatewaySocketPath,
    windowsPipeModulePath,
    gateway: clientGateway,
    journal: eventJournal,
    subscriptions: gatewaySubscriptions,
    observation: conversationObservation,
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
    publishWorkspaceSnapshot: (workspaceId, connectionId) => {
      return workspaceGatewayRuntime.publishWorkspaceSnapshot(
        workspaceId,
        'local:local-installation',
        connectionId,
      );
    },
    closeConnection: connectionId => {
      workspaceGatewayRuntime.closeConnection(connectionId);
    },
    registerDesktopSession: (nonce, accountId) => desktopSessions.issue(nonce, accountId),
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
  eventJournalRuntime.start();
  // Rebuild yields between bounded batches. Navigation reports rebuilding
  // instead of doing an account-wide scan on a client request.
  const directoryRebuild = directoryProjector.rebuild().catch((error: unknown) => {
    console.error(`Workspace directory rebuild failed: ${(error as Error).message}`);
  });
  let directoryDrain: Promise<void> | null = null;
  const directoryProjectionTimer = setInterval(() => {
    if (directoryDrain) return;
    directoryDrain = directoryProjector!.drainChanges()
      .catch((error: unknown) => console.error(`Workspace activity projection failed: ${(error as Error).message}`))
      .finally(() => { directoryDrain = null; });
  }, 250);
  directoryProjectionTimer.unref();
  if (cliCommand.kind === 'server') {
    let feishuNotificationPort: FeishuGatewaySessionPort | null = null;
    const clientActions = new ClientActionReferences(new SqliteClientActionReferences(db));
    const notificationRouting = new NotificationRoutingService({
      store: notificationStore,
      current: (route, cursor) => {
        const [taskCursor, permissionCursor] = cursor ? JSON.parse(cursor) as [string | null, string | null] : [null, null];
        const page = new SqliteConversationActivitySource(db).page(route.accountId, route.conversationId, taskCursor ?? undefined, 1);
        const task = page.tasks[0];
        if (!task) {
          const latest = conversationReadModel.page(route.accountId, route.conversationId, { limit: 1 }).turns[0];
          const fact = latest && notificationFromTurn(route.accountId, latest);
          return { facts: fact ? [fact] : [], nextCursor: null };
        }
        const pending = permissionNotificationPage(task.id, permissionCursor ?? '');
        const facts = [...pending.facts];
        const value = activityProjection.read(task.id);
        const turn = conversationReadModel.findTaskTurn(route.accountId, route.conversationId, task.id);
        if (value) facts.push({ accountId: route.accountId, conversationId: route.conversationId,
          taskId: task.id, requestId: turn?.requestId ?? null, subjectId: task.id, category: 'progress',
          version: createHash('sha256').update(JSON.stringify(value)).digest('hex'), payload: value });
        return { facts, nextCursor: pending.nextId !== null ? JSON.stringify([taskCursor, pending.nextId])
          : page.nextCursor !== null ? JSON.stringify([page.nextCursor, null]) : null };
      },
      authorize: async route => route.accountId === LOCAL_DEFAULT_ACCOUNT_ID
        && route.principalId === `feishu:${route.destination.tenantKey}:${route.destination.senderId}`
        && Boolean((await conversationStore.readMetadata(route.conversationId))?.archived === false)
        && Boolean(await workspaceDirectory.resolveConversationWorkspace(route.conversationId, route.principalId)),
      valid: job => {
        if (job.fact.category !== 'approval') return true;
        const request = new SqlitePermissionRepository(db).findRequest(job.fact.subjectId);
        const task = request && taskRepo.findById(request.request.taskId);
        const revision = request && accountRuntimeComposition.runtimePort.queries.findActiveWorkGraphRevision(request.request.taskId);
        return Boolean(request?.status === 'escalated'
          && task && !isTerminalTaskLifecycle(toTaskLifecycleState(task.status))
          && revision?.generationId === request.request.generationId
          && request.request.fingerprint === job.fact.version
          && Date.parse(request.createdAt) + 24 * 60 * 60 * 1000 > Date.now()
          && !new KernelWorkflowRepo(db).findPermissionResolution(job.fact.subjectId));
      },
      deliver: async job => {
        if (!feishuNotificationPort) throw new Error('feishu_transport_unavailable');
        await feishuNotificationPort.deliverNotification(job);
      },
      onError: error => console.error(`Notification delivery: ${(error as Error).message}`),
    });
    stopNotifications = () => notificationRouting.stop();
    const feishuRouting = new FeishuConversationRouting({
      actions: clientActions,
      notifications: notificationRouting,
      observation: conversationObservation,
      subscriptions: gatewaySubscriptions,
      navigation: new SqliteClientNavigationStore(db),
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      gateway: clientGateway,
      bindings: conversationBindings,
      attachments: webAttachmentStore,
      onAttachmentFailed: input => {
        // §5.5.6/§5.5.7: the exact stage of an attachment failure is surfaced
        // durably (audit) and operator-visibly — never silently dropped. The
        // image-resolution success/failure additionally reaches the user's
        // activity card through the gateway_attachment_resolved trace event.
        const message = `Feishu attachment resolution failed: ${input.name} (${input.kind}) -> ${input.reason}`;
        console.error(message);
        new GatewayAuditLog(resolve(accountPaths.gateway, 'gateway-audit.jsonl')).record({
          platform: 'feishu',
          kind: 'inbound',
          target: input.chatId ?? input.conversationId,
          method: 'file',
          ok: false,
          reason: 'attachment_resolution_failed',
          error: message,
        });
      },
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
      actions: clientActions,
      observation: conversationObservation,
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      tenantKey: config.gateway?.platforms?.feishu?.app_id ?? 'local-feishu-app',
      adapter: new FeishuGatewayAdapter({
        gateway: clientGateway,
        routing: feishuRouting,
      }),
      subscriptions: gatewaySubscriptions,
      onSystemMessage: (...lines) => console.log(lines.join('\n')),
      listTaskArtifacts: (taskId: string) => new TaskArtifactRepo(db)
        .listByTask(taskId)
        .map(record => ({
          displayName: record.displayName,
          publishedPath: record.publishedPath,
          mediaType: record.mediaType,
          previewKind: record.previewKind,
        })),
      billing: billingServices.queries,
      runtimePaths: {
        pairing: resolve(accountPaths.gateway, 'feishu-pairings.json'),
        audit: resolve(accountPaths.gateway, 'gateway-audit.jsonl'),
        uploads: resolve(accountPaths.gateway, 'feishu-uploads'),
        replies: resolve(accountPaths.gateway, 'feishu-replies'),
        config: resolve(accountPaths.config, 'config.yaml'),
      },
    });
    feishuNotificationPort = feishuPort;
    notificationTimer = setInterval(() => {
      if (notificationDrain) return;
      notificationDrain = notificationRouting.drain().catch(error => console.error(`Notification outbox: ${(error as Error).message}`))
        .finally(() => { notificationDrain = null; });
    }, 250);
    notificationTimer.unref();
    gatewayFeishuManager = new FeishuRuntimeManager({ session: feishuPort });
    await gatewayFeishuManager.applyConfiguration(config);
  }

  if (cliCommand.kind === 'server') {
    const workGraphPresentationProjector = new WorkGraphPresentationProjector();
    managementServer = await startWebMode({
      conversationGateway: { accountId: LOCAL_DEFAULT_ACCOUNT_ID, observation: conversationObservation, commands: webGatewayAdapter },
      launchContexts: webLaunchContexts,
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
      desktopSessions,
      clientNotifications: { read: cursor => clientNotifications.read(LOCAL_DEFAULT_ACCOUNT_ID, cursor) },
      serviceActivity: () => activityProjection.serviceSummary(LOCAL_DEFAULT_ACCOUNT_ID),
      agentReadiness,
      sessionRuntime: new WebGatewaySessionRuntime({
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        catalog: webSessionCatalog,
        readBillingTurnFacts: async (conversationId, turnId) => {
          const turn = conversationReadModel.findTurn(LOCAL_DEFAULT_ACCOUNT_ID, conversationId, turnId);
          const legacy = await webSessionCatalog.readTurn(conversationId, turnId);
          return turn ? { userInput: turn.userInput, traceEvents: legacy?.traceEvents } : legacy;
        },
        gateway: webGatewayAdapter,
        attachments: webAttachmentStore,
        normalizeTurnPresentation,
        billing: billingServices.queries,
        authorizeTask: (accountId, taskId) => {
          const task = taskRepo.findById(taskId);
          return Boolean(task && task.accountId === accountId);
        },
        listAccountTasks: accountId => taskRepo.findAll()
          .filter(task => task.accountId === accountId)
          .map(task => ({ id: task.id, title: task.title })),
        projectExecutionTimeline: taskId => {
          const task = taskRepo.findById(taskId);
          return task ? executionProjector.project(task) : null;
        },
        projectExecutionTimelines: taskIds => executionProjector.projectMany(
          taskRepo.findTimelineByIds(LOCAL_DEFAULT_ACCOUNT_ID, taskIds),
        ),
        resolveTaskIdsForTurns: turnIds => billingServices.contexts.taskIdsForTurns(LOCAL_DEFAULT_ACCOUNT_ID, turnIds),
        projectTasksArtifacts: taskIds => {
          const grouped = new Map<string, ArtifactProjection[]>();
          for (const artifact of taskArtifactRepo.listByTasks(LOCAL_DEFAULT_ACCOUNT_ID, taskIds)) {
            const items = grouped.get(artifact.taskId) ?? [];
            items.push(taskArtifactRepo.toProjection(artifact));
            grouped.set(artifact.taskId, items);
          }
          return grouped;
        },
        resolveTaskIdForTurn: turnId => {
          const queryContext = billingServices.contexts.findByTurnId(
            LOCAL_DEFAULT_ACCOUNT_ID,
            turnId,
          );
          return queryContext
            ? billingServices.contexts.findTaskLink(queryContext.queryId)?.costTaskId ?? null
            : null;
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
        getExecutorManagement: async config => projectExecutorManagement(
          executorDraftSnapshot(configurationRuntimeCoordinator.getSnapshot(), config),
        ),
        prepareExecutor: ({ baseRevisionId, change, config }) =>
          configurationService.prepareExecutorDraft(change, baseRevisionId, config),
        getExecutorCapabilityManual: async (agentClassRef, revisionId) => {
          const snapshot = await configurationService.getSnapshot(
            revisionId ?? (await configurationService.getActiveSnapshot()).revisionId,
          );
          return buildExecutorManualPreview(snapshot, agentClassRef);
        },
        analyzeExecutorManual: (agentClassRef, input) => configurationActivationGate.withActivation(() => executorManualPreview.compile({
          agentClassRef,
          baseRevisionId: input.baseRevisionId,
          sourceText: input.sourceText,
          ...(input.config ? {
            candidateConfig: input.config as AnyFusionConfigurationV2,
          } : {}),
        })),
        compileExecutorManual: (agentClassRef, input) => configurationActivationGate.withActivation(() => executorManualPreview.compile({
          agentClassRef,
          baseRevisionId: input.baseRevisionId,
          sourceText: input.sourceText,
          ...(input.config ? {
            candidateConfig: input.config as AnyFusionConfigurationV2,
          } : {}),
        })),
        previewExecutorCapabilityManual: (agentClassRef, input) => (
          configurationService.previewExecutorCapabilityManual(
            agentClassRef,
            input.baseRevisionId,
            input.config,
          )
        ),
        describeAgentCapabilities: (input, refresh) => agentCapabilityDescriptions.describe(input, refresh),
        summarizeModelInformation: async catalogModelId => {
          const catalog = await openRouterModelCatalog.getSnapshot();
          const model = catalog.models[catalogModelId];
          if (!model) throw new Error('OpenRouter 未找到所选模型，请重新获取模型信息。');
          return { catalogModelId, routingNotes: await modelRoutingProfiles.summarize(model) };
        },
        suggestAgentResponsibility: async ({ agentClassRef, sourceText, config, modelFacts }) => {
          const snapshot = config && typeof config === 'object'
            ? { config: config as AnyFusionConfigurationV2, revisionId: 'draft', contentHash: '' }
            : await configurationService.getActiveSnapshot();
          const agentClass = snapshot.config.agentClasses[agentClassRef];
          if (!agentClass) throw new Error(`unknown AgentClass: ${agentClassRef}`);
          const modelRefs = agentClass.modelPolicy.mode === 'fixed'
            ? [agentClass.modelPolicy.modelRef]
            : [...new Set([
              ...agentClass.modelPolicy.allowedModelRefs,
              ...(agentClass.modelPolicy.defaultModelRef ? [agentClass.modelPolicy.defaultModelRef] : []),
            ])];
          const openRouterSnapshot = await openRouterModelCatalog.getSnapshot();
          const resolvedModelFacts = modelFacts && modelFacts.length > 0
            ? modelFacts
            : modelRefs.flatMap(modelRef => {
              const model = snapshot.config.models[modelRef];
              const publicModel = model ? matchOpenRouterModel(openRouterSnapshot, model.modelId) : undefined;
              return model ? [{
                modelRef,
                modelId: model.modelId,
                capabilities: model.capabilities,
                ...(model.routingNotes ? { routingNotes: model.routingNotes } : {}),
                ...(publicModel?.description ? { description: publicModel.description } : {}),
                ...(publicModel?.contextLimit !== undefined ? { contextLimit: publicModel.contextLimit } : {}),
                ...(publicModel?.costInputPerMillion !== undefined ? { costInputPerMillion: publicModel.costInputPerMillion } : {}),
                ...(publicModel?.costOutputPerMillion !== undefined ? { costOutputPerMillion: publicModel.costOutputPerMillion } : {}),
                ...(publicModel?.publicFacts ? { publicFacts: publicModel.publicFacts } : {}),
              }] : [];
            });
          return settingsAssistant.suggestAgentResponsibility({
            agentClassRef,
            sourceText,
            modelFacts: resolvedModelFacts,
          });
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
          const providerCatalog = await buildProviderCompletionCatalog({
            providers: snapshot.config.providers,
            models: snapshot.config.models,
            readSecret: async reference => {
              assertSecretReference(reference);
              return secretStore.get(reference);
            },
          });
          const openRouterCatalog = await openRouterModelCatalog.getSnapshot();
          return new ConfigurationCompletionService({
            providerCatalog,
            presets: PUBLIC_PROVIDER_PRESETS,
            modelCapabilities: MODEL_CAPABILITY_CATALOG,
            openRouterCatalog,
          }).complete({
            providers: Object.fromEntries(
              Object.entries(snapshot.config.providers).map(([providerRef, provider]) => [
                providerRef,
                {
                  baseUrl: provider.baseUrl,
                  credentialAvailable: providerCatalog
                    .find(item => item.providerRef === providerRef)?.credentialAvailable ?? false,
                  credentialFingerprint: providerCatalog
                    .find(item => item.providerRef === providerRef)?.credentialFingerprint,
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
                  pricing: model.pricing,
                  latencyTier: model.latencyTier,
                  qualityTier: model.qualityTier,
                },
              ]),
            ),
            agentClasses: snapshot.config.agentClasses as unknown as Record<string, Record<string, unknown>>,
          });
        },
        discoverProviderModels: async input => {
          const baseUrl = input.baseUrl.trim();
          let apiKey = input.apiKey?.trim() ?? '';
          if (!apiKey && input.providerRef) {
            try {
              const snapshot = await configurationService.getActiveSnapshot();
              const provider = snapshot.config.providers[input.providerRef];
              if (provider) {
                assertSecretReference(provider.apiKeyRef);
                apiKey = (await secretStore.get(provider.apiKeyRef)).trim();
              }
            } catch {
              apiKey = '';
            }
          }
          if (!/^https?:\/\//iu.test(baseUrl)) {
            return { status: 'unavailable' as const, modelIds: [], capabilities: {} };
          }
          if (!apiKey && /openrouter\.ai/iu.test(baseUrl)) {
            const openRouterCatalog = await openRouterModelCatalog.getSnapshot({ forceRefresh: true });
            const modelIds = Object.keys(openRouterCatalog.models).sort();
            return {
              status: modelIds.length > 0 ? 'discovered' as const : 'unavailable' as const,
              modelIds,
              capabilities: Object.fromEntries(modelIds.map(modelId => [
                modelId,
                openRouterCatalog.models[modelId]?.capabilities ?? [],
              ])),
              metadata: Object.fromEntries(modelIds.flatMap(modelId => {
                const model = openRouterCatalog.models[modelId];
                return model ? [[modelId, {
                  ...(model.displayName ? { displayName: model.displayName } : {}),
                  ...(model.description ? { description: model.description } : {}),
                  ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
                  ...(model.costInputPerMillion !== undefined ? { costInputPerMillion: model.costInputPerMillion } : {}),
                  ...(model.costOutputPerMillion !== undefined ? { costOutputPerMillion: model.costOutputPerMillion } : {}),
                  ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),
                  ...(model.pricing ? { pricing: model.pricing } : {}),
                }]] : [];
              })),
            prices: Object.fromEntries(modelIds.flatMap(modelId => {
                const model = openRouterCatalog.models[modelId];
                return model ? [[modelId, {
                  ...(model.costInputPerMillion !== undefined ? { inputCnyPerMillion: model.costInputPerMillion } : {}),
                  ...(model.costOutputPerMillion !== undefined ? { outputCnyPerMillion: model.costOutputPerMillion } : {}),
                  ...(model.pricing ? { pricing: model.pricing } : {}),
                }]] : [];
              })),
            };
          }
          if (!apiKey) return { status: 'unavailable' as const, modelIds: [], capabilities: {} };
          const discovery = await discoverOpenAiCompatibleModels({ baseUrl, apiKey });
          // OpenRouter 的公开目录不需要登录；它只用于补充任意 Provider
          // 返回的同名模型事实，只有 OpenRouter Provider 才把目录模型全部列出。
          const openRouterCatalog = await openRouterModelCatalog.getSnapshot();
          const openRouterModelIds = /openrouter\.ai/iu.test(baseUrl)
            ? Object.keys(openRouterCatalog.models)
            : [];
          const modelIds = [...new Set([...discovery.modelIds, ...openRouterModelIds])].sort();
          return {
            status: modelIds.length > 0 ? 'discovered' as const : discovery.status,
            modelIds,
            capabilities: Object.fromEntries(modelIds.map(modelId => [
              modelId,
              [...new Set([
                ...knownModelCapabilities(modelId),
                ...(openRouterCatalog.models[modelId]?.capabilities ?? []),
              ])],
            ])),
            metadata: Object.fromEntries(modelIds.flatMap(modelId => {
              const model = openRouterCatalog.models[modelId];
              return model ? [[modelId, {
                ...(model.displayName ? { displayName: model.displayName } : {}),
                ...(model.description ? { description: model.description } : {}),
                ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
                ...(model.costInputPerMillion !== undefined ? { costInputPerMillion: model.costInputPerMillion } : {}),
                ...(model.costOutputPerMillion !== undefined ? { costOutputPerMillion: model.costOutputPerMillion } : {}),
                ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),
                ...(model.pricing ? { pricing: model.pricing } : {}),
              }]] : [];
            })),
            prices: Object.fromEntries(modelIds.flatMap(modelId => {
              const model = openRouterCatalog.models[modelId];
              return model ? [[modelId, {
                ...(model.costInputPerMillion !== undefined ? { inputCnyPerMillion: model.costInputPerMillion } : {}),
                ...(model.costOutputPerMillion !== undefined ? { outputCnyPerMillion: model.costOutputPerMillion } : {}),
                ...(model.pricing ? { pricing: model.pricing } : {}),
              }]] : [];
            })),
          };
        },
        activate: async (baseRevisionId, nextConfig, secrets, spanApiKey) => {
          const result = await configurationRuntimeCoordinator.activate({
            expectedRevisionId: baseRevisionId,
            config: nextConfig,
            secrets,
            ...(spanApiKey !== undefined ? { spanApiKey } : {}),
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
        getSpanCredentialStatus: async () => {
          try {
            const apiKey = (await secretStore.get(SPAN_ROUTING_SECRET_REFERENCE as SecretReference)).trim();
            return { configured: apiKey.length > 0 };
          } catch {
            return { configured: false };
          }
        },
        getSecretStatus: async providerRefs => {
          const status: Record<string, {
            configured: boolean;
            maskedApiKey: string | null;
          }> = {};
          for (const providerRef of providerRefs) {
            const reference = `file-secret:anyfusion/providers/${providerRef}` as const;
            try {
              const apiKey = (await secretStore.get(reference)).trim();
              const credentialFingerprint = fingerprintProviderCredential(apiKey);
              status[providerRef] = {
                configured: apiKey.length > 0,
                maskedApiKey: apiKey ? maskApiKey(apiKey) : null,
                ...(credentialFingerprint ? { credentialFingerprint } : {}),
              };
            } catch {
              status[providerRef] = { configured: false, maskedApiKey: null };
            }
          }
          return status;
        },
        verifySecret: async (providerRef, requestedBaseUrl) => {
          const reference = `file-secret:anyfusion/providers/${providerRef}` as const;
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
        // Stop admitting new Turns first, then interrupt in-flight Span calls
        // so shutdown never waits on an external request and no late ranking
        // observation can be admitted afterwards.
        spanRoutingShutdown.abort();
        clientGateway.closeAdmission();
        conversationGatewayRuntime.closeAdmission();
        if (notificationTimer) clearInterval(notificationTimer);
        await notificationDrain;
        await stopNotifications?.();
        await Promise.all([
          managementServer?.stop() ?? Promise.resolve(),
          gatewayFeishuManager?.stop() ?? Promise.resolve(),
          gatewayServer.stop(),
          markdownPreviewServer?.stop() ?? Promise.resolve(),
        ]);
      },
      drain: async () => {
        clearInterval(taskPoolReviewTimer);
        clearInterval(activityProjectionTimer);
        if (notificationTimer) clearInterval(notificationTimer);
        await notificationDrain;
        clearInterval(directoryProjectionTimer);
        await directoryRebuild;
        await directoryDrain;
        await clientGateway.drain();
        await conversationGatewayRuntime.drain();
        await conversationRegistry.closeAll();
        await eventJournalRuntime.stop();
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
        desktopReady = false;
        const current = await readEndpointManifest(endpointManifestPath);
        if (current) {
          await writeEndpointManifest(endpointManifestPath, {
            ...current,
            state: 'draining',
          }, windows);
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
        }, windows);
      },
      removeManifest: () => removeEndpointManifest(endpointManifestPath),
    });
    await serverApplication.start();
    desktopReady = true;
    console.log(`MetaWork Server ready: ${gatewaySocketPath}`);
    await new Promise(() => undefined);
    return;
}
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : { value };
}

function maskApiKey(value: string): string {
  return `••••••••${value.slice(-4)}`;
}
