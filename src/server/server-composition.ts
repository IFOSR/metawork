import { createUsagePayerResolver } from '../metering/usage-payer.js';
import { createManagerQuotaPreflight } from './manager-quota-preflight.js';
import { readAccountTokenQuota } from '../metering/account-token-quota.js';
import { createTokenUsageManagementQuery, type TokenUsageManagementQuery } from '../management/token-usage-management.js';
import { SqliteResourceLeaseRepository } from '../storage/resource-lease-repo.js';
import { RuntimeHomeMaterializer } from '../executor/runtime-home-materializer.js';
import { ConversationDeletionService } from '../session/conversation-deletion.js';
import { SqliteConversationDeletionStore } from '../storage/conversation-deletion-repo.js';
import { SqliteConversationTurnStore } from '../storage/conversation-turn-repo.js';
import { ManagedLocalServices } from '../execution/managed-local-service.js';
import { ManagedLocalServiceRepo } from '../storage/managed-local-service-repo.js';
import { resolveHostToolPath } from '../utils/host-tool-path.js';
import { resolveExecutorTool } from '../utils/executor-tool-path.js';
import { defaultVersionProbe } from '../management/agent-installation-readiness-service.js';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { DesktopSessionService } from '../management/desktop-session.js';
import { ClientNotificationFeed, type ClientNotificationPage } from '../gateway/client-notification-feed.js';
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
import { TaskSearchIndexRepo } from '../storage/task-search-index-repo.js';
import { TaskEngine } from '../task/task-engine.js';
import { OrchestrationEngine } from '../guidance/orchestration.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import { formatCliHelp, parseCliArgs } from '../cli/args.js';
import { runConfigurationAdmin, type ConfigurationMutationResult } from '../commands/configuration-admin.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import {
  FilePendingProviderStore,
  type PendingProviderStore,
} from '../configuration/pending-provider-store.js';
import {
  bootstrapContainerConfiguration,
  containerBootstrapRequested,
  ensureBootstrapProviderCredentials,
} from '../configuration/container-bootstrap.js';
import { createConfigurationRevisionId } from '../configuration/revision-id.js';
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
  importLocalAgentCredentials,
  importLegacyProviderCredentials,
  cleanupProviderCredentials,
} from '../configuration/index.js';
import { prepareProductionSecretStore } from '../configuration/production-secret-store.js';
import {
  SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
  SPAN_ROUTING_SECRET_REFERENCE,
} from '../configuration/schema.js';
import {
  isSystemOneDecisionModel,
  SpanRoutingAdvisor,
} from '../routing/span-routing-advisor.js';
import { fetchManualModelInformation } from '../configuration/manual-model-information.js';
import {
  assertSecretReference,
  type SecretReference,
  type SecretStore,
} from '../configuration/secret-store.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { assertCompleteRuntime } from '../installation/runtime-artifacts.js';
import { AccountLayoutMigrator } from '../installation/account-layout-migrator.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { buildAccountRuntimeComposition } from '../account/account-runtime-composition.js';
import { createManagerPermissionContextResolver } from '../account/manager-permission-context.js';
import { RuntimeRegistry } from '../account/runtime-registry.js';
import { ConversationRegistry } from '../session/conversation-registry.js';
import { createNotificationService } from '../notifications/feishu.js';
import { nanoid } from 'nanoid';
import { MetaclawGatewayServer } from '../gateway/server.js';
import { resolveGatewaySocketPath } from '../gateway/gateway-paths.js';
import { resolveLocalEndpointPath } from '../platform/local-endpoint.js';
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
import { settleObservedTurn } from '../session/settle-observed-turn.js';
import { ConversationObservationService } from '../gateway/conversation-observation.js';
import { createConversationReadModel } from './conversation-read-model-composition.js';
import { ConversationReadProjector } from '../session/conversation-read-projector.js';
import { SqliteConversationActivitySource } from '../storage/conversation-activity-source.js';
import type { ConversationActivityTask } from '../session/conversation-activity-source.js';
import { TASK_STATUS_LABELS, isTerminalTaskStatus } from '../task/task-state.js';
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
import { workspaceWriteStateOf } from '../core/workspace-execution.js';
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
import { resolveWorkspaceRoot } from '../workspace/workspace-root.js';
import { WorkspaceDirectoryBrowser } from '../management/workspace-directory-browser.js';
import {
  AgentInstallationReadinessService,
} from '../management/agent-installation-readiness-service.js';
import { WorkspaceGatewayRuntime } from '../gateway/workspace-gateway-runtime.js';
import { recordConversationInputTitle } from '../session/conversation-title.js';
import { workspaceEventStreamId } from '../gateway/workspace-event-stream.js';
import { clientConnectionEventStreamId } from '../gateway/client-connection-event-stream.js';
import { resolveServerWebPort } from './server-web-port.js';
import { serverBindingFromEnv } from './server-binding.js';
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
import { resolvePlanningTransport } from '../planning/manager-host/transport-selection.js';
import { managerProviderEnv, writeManagerProviderConfig } from '../planning/manager-host/provider-config.js';
import { buildStagedLegacyConfiguration } from '../configuration/staged-legacy-configuration.js';
import { buildPlannerInputProfile } from '../planning/planner-input-profile.js';
import { buildPlannerConfigurationView, buildRuntimeConfigurationView, buildExecutorManualPreview } from '../configuration/projections.js';
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
import { projectPublicDelivery } from '../delivery/public-delivery-view.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import type { WorkGraphProposal, WorkGraphSubtask } from '../work-graph/types.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { WorkspaceChangeRecordRepo } from '../storage/workspace-change-record-repo.js';
import { ArtifactVersionRepo } from '../storage/artifact-version-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import { ControlDispatchItemRepo } from '../storage/dispatch-item-repo.js';
import {
  acquireInstanceLock,
  consumeShutdownMarker,
  isInstanceRunning,
  SERVER_SHUTDOWN_MARKER,
  readInstanceLock,
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
  providerModelListRequest,
  fingerprintProviderCredential,
} from '../configuration/provider-model-discovery.js';
import { matchOpenRouterModel, OpenRouterModelCatalog } from '../configuration/openrouter-model-catalog.js';
import { SettingsAssistant } from '../configuration/settings-assistant.js';
import { InternalLlmService } from '../configuration/internal-llm-service.js';
import { resolvePreferredModel } from '../configuration/preferred-model-resolver.js';
import { ModelRoutingProfileService } from '../configuration/model-routing-profile-service.js';
import { AgentCapabilityDescriptionService } from '../configuration/agent-capability-description.js';
import { CAPABILITY_EXPLANATION_PROMPT } from '../configuration/agent-capability-description-prompt.js';
import { PreferredModelError, type DegradationNotice } from '../configuration/internal-llm-service.js';
import { ConfigurationRevisionRepo } from '../storage/configuration-revision-repo.js';
import {
  classifyServerReadiness,
  writeEndpointManifest,
  readEndpointManifest,
  removeEndpointManifest,
} from '../server/server-endpoint-manifest.js';
import { readReleaseIdentity } from '../installation/release-identity.js';
import { armExitWatchdog } from './exit-watchdog.js';
import { findInstalledServerProcesses } from '../management/server-process-scan.js';
import {
  createServerApplication,
} from './server-application.js';
import { createServerComposition } from './server-composition-contract.js';
import { stopServerRuntimes } from './server-runtime-shutdown.js';
import { createServerMeteringServices } from './metering-composition.js';
import { createUsageRecorder } from '../metering/usage-service.js';
import { createManagerPermissionUsageRecorder } from './manager-permission-usage.js';
import { DEFAULT_PLAN_QUOTA_CATALOG, type PlanQuotaDefinition } from '../metering/plan-quota.js';
import { decideHostedQuota } from '../metering/quota-enforcement.js';
import { resolveTaskViewTurnAssociation } from '../gateway/task-view-association.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import { createBackgroundResultDelivery } from '../gateway/background-result-delivery.js';
import { DEFAULT_OFFICIAL_SERVICE_URL, OfficialServiceClient, LocalAuthorizationService } from '../authorization/index.js';
import {
  MemoryRuntimeController,
  describeMemoryStatus,
} from '../memory/memory-runtime-controller.js';
import { resolveMemorySidecarCommand } from '../memory/memory-sidecar-command.js';
import { MemoryEvidenceService } from '../memory/memory-evidence-service.js';
import { createMemoryManagementQuery, type MemoryManagementQuery } from '../management/memory-management.js';

function toMutationResult(result: ActivateDraftResult): ConfigurationMutationResult {
  if (result.ok) return { ok: true, revisionId: result.snapshot.revisionId };
  return { ok: false, code: result.code, activeRevisionId: result.activeRevisionId };
}

function localAgentCredentialSources() {
  return {
    piHomes: [join(homedir(), '.config', 'anyfusion', 'pi-home', '.pi')],
    plannerHomes: [join(homedir(), '.config', 'anyfusion', 'planner')],
  };
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

/**
 * 可用 Provider 集合 = 已激活配置 ∪ 待激活暂存区。
 *
 * 已激活优先：它是权威事实。暂存区只补"用户填好但还没保存激活"的 Provider，
 * 让需要调用模型的辅助功能在等待激活期间可用。两者都只提供端点与密钥引用，
 * 密钥本体始终留在凭据库。
 */
async function resolvePreferredProviders(
  active: Readonly<Record<string, { baseUrl: string; apiKeyRef: string; protocol: string; enabled?: boolean } | undefined>>,
  pendingStore: PendingProviderStore,
): Promise<Record<string, { baseUrl: string; apiKeyRef: string; protocol: string; enabled?: boolean }>> {
  const pending = await pendingStore.read();
  const merged: Record<string, { baseUrl: string; apiKeyRef: string; protocol: string; enabled?: boolean }> = {};
  for (const provider of pending) {
    merged[provider.providerRef] = {
      baseUrl: provider.baseUrl,
      apiKeyRef: provider.apiKeyRef,
      protocol: provider.protocol,
    };
  }
  for (const [providerRef, provider] of Object.entries(active)) {
    if (provider) merged[providerRef] = provider;
  }
  return merged;
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
  officialAuthorization?: LocalAuthorizationService;
  sandboxSessionExchange?: (et: string) => Promise<Parameters<LocalAuthorizationService['adoptSession']>[0]>;
  memoryQuery?: MemoryManagementQuery;
  /** 配置的工作目录根；null 表示不限制。 */
  workspaceRoot?: string | null;
  tokenUsageQuery?: TokenUsageManagementQuery;
}): Promise<ManagementServer> {
  const webDistDir = process.env.ANYFUSION_WEB_DIST
    ? resolve(process.env.ANYFUSION_WEB_DIST)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  const binding = serverBindingFromEnv(process.env);
  const managementServer = new ManagementServer({
    port: options.port,
    host: binding.host,
    allowedOrigins: binding.allowedOrigins,
    trustProxy: binding.trustProxy,
    webDistDir,
    token: options.webAuth.manualAccessToken,
    webAuth: options.webAuth,
    desktopSessions: options.desktopSessions,
    clientNotifications: options.clientNotifications,
    serviceActivity: options.serviceActivity,
    conversationGateway: options.conversationGateway,
    launchContexts: options.launchContexts,
    workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser({
      workspaceRoot: () => options.workspaceRoot ?? null,
    }),
    workspaceRoot: options.workspaceRoot ?? null,
    runningRevisionId: options.runningRevisionId,
    sessionRuntime: options.sessionRuntime,
    executionQuery: options.executionQuery,
    configQuery: options.configQuery,
    configurationRuntime: options.configurationRuntime,
    attachmentStore: options.attachmentStore,
    artifactQuery: options.artifactQuery,
    agentReadiness: options.agentReadiness,
    officialAuthorization: options.officialAuthorization,
    sandboxSessionExchange: options.sandboxSessionExchange,
    ...(options.tokenUsageQuery ? { tokenUsageQuery: options.tokenUsageQuery } : {}),
    ...(options.memoryQuery ? { memoryQuery: options.memoryQuery } : {}),
  });
  await managementServer.start();
  process.stdout.write([
    `MetaWork Web: ${managementServer.address}`,
    formatWebAccessTokenLine(options.webAuth.manualAccessToken),
  ].join('\n') + '\n');
  return managementServer;
}

export async function main(cliCommand = parseCliArgs(process.argv.slice(2))) {
  const toolPath = await resolveHostToolPath(process.env);
  if (toolPath !== undefined) process.env.PATH = toolPath;
  const paths = resolveMetaWorkPaths();
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const applicationRoot = existsSync(paths.appCurrent)
    ? paths.appCurrent
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

  // Surface secrets such as FEISHU_APP_SECRET live next to the install root
  // .env; load them before any gateway/platform wiring runs. Existing process
  // environment entries always win.
  loadEnvFileIfExists(join(paths.root, '.env'));
  const openRouterModelCatalog = new OpenRouterModelCatalog({
    cachePath: resolve(paths.root, 'metadata/openrouter-models.json'),
  });

  if (cliCommand.kind === 'help') {
    process.stdout.write(`${formatCliHelp()}\n`);
    return;
  }

  // A partial build used to leave the Server healthy while every attempt
  // failed at preparation with an unactionable ENOENT. Refuse to accept work
  // on an incomplete runtime and name the repair step instead.
  if (cliCommand.kind === 'server' && cliCommand.action === 'start') {
    assertCompleteRuntime(applicationRoot);
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
    // Liveness decides "running"; the lock record only supplies the age that
    // separates a starting Server from one stuck inside its exit. A stale lock
    // left by a forced kill must never be reported as a live instance.
    const instanceRunning = await isInstanceRunning(runtimeLockPath);
    const instance = instanceRunning ? await readInstanceLock(runtimeLockPath) : null;
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
      lockAgeMs: instance ? Date.now() - Date.parse(instance.startedAt) : undefined,
    });
    process.stdout.write(readiness === 'ready'
      ? 'MetaWork Server 正在运行。\n'
      : readiness === 'zombie'
        ? `MetaWork Server 进程仍在（PID ${instance?.pid}），但端点与 Gateway socket 已回收：这是卡在退出阶段的僵死实例，不再服务任何客户端。\n`
          + '执行 `metawork server stop --force` 清理它，然后 `metawork server start`。\n'
        : readiness === 'starting_or_failed'
          ? 'MetaWork Server 尚未就绪：正在启动或启动失败，请检查 Server terminal。\n'
          : 'MetaWork Server 未运行。请执行 `metawork server start`。\n');
    return;
  }

  if (cliCommand.kind === 'server' && cliCommand.action === 'stop') {
    const result = await stopInstanceForRestart(runtimeLockPath, { force: cliCommand.force });
    const orphaned = cliCommand.force && result.status === 'not_running'
      ? await findInstalledServerProcesses(paths.root)
      : [];
    for (const pid of orphaned) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    process.stdout.write(
      result.status === 'stopped'
        ? `MetaWork Server 已停止（PID ${result.pid}）。\n`
        : orphaned.length > 0
          ? `MetaWork Server 运行锁已不存在；已强制结束残留实例 PID ${orphaned.join(', ')}。\n`
          : 'MetaWork Server 未运行。\n',
    );
    return;
  }

  if (cliCommand.kind === 'server' && cliCommand.action === 'restart') {
    const result = await stopInstanceForRestart(runtimeLockPath, { force: cliCommand.force });
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
          "SELECT status, COUNT(*) AS count FROM dispatch_items WHERE status IN ('pending_launch', 'launching', 'cancelling', 'uncertain') GROUP BY status",
        ).all() as Array<{ status: string; count: number }>;
        const orphanDispatch = diagDb.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_items AS item WHERE item.status IN ('pending_launch', 'launching', 'cancelling', 'uncertain') AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = item.task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived'))",
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
    const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
    await prepareProductionSecretStore(secretStore);
    await importLegacyProviderCredentials({
      target: secretStore,
      providers: activeSnapshot.config.providers,
      legacyStore: legacySecretStore,
    });
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
      activate: async config => {
        const result = await activateConfiguration(
          configurationService,
          config,
          activeSnapshot.revisionId,
        );
        if (result.ok) {
          // Credential cleanup follows a committed activation; it must never
          // turn a successful activation into a failed command.
          try {
            await cleanupProviderCredentials({
              secretStore,
              previous: activeSnapshot.config,
              next: config,
              logger: message => console.warn(`[config] ${message}`),
            });
          } catch (error) {
            console.warn(`[config] credential cleanup failed: ${(error as Error).message}`);
          }
        }
        return result;
      },
    });
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // Only standalone Server startup owns the Runtime instance lock. Client
  // launchers are separated from this composition in the following tasks.
  let instanceLock: InstanceLock | null = null;
  // 可选的工作目录根：配置了就必须存在且是目录，否则启动失败。
  // 一个拼错的根路径会让用户"看不到任何目录"，比启动即报错更难解释。
  // 校验只在 Server 模式下执行——status/stop/doctor 与客户端启动仍可照常使用。
  let workspaceRoot: string | null = null;
  if (cliCommand.kind === 'server') {
    workspaceRoot = await resolveWorkspaceRoot(process.env).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`工作目录根配置无效：${message}`);
    });
    if (workspaceRoot) {
      console.log(`[workspace-root] 用户可选工作目录根：${workspaceRoot}`);
    }
  }
  if (cliCommand.kind === 'server') {
    const dataDir = paths.data;
    mkdirSync(dataDir, { recursive: true });
    instanceLock = await acquireInstanceLock(resolve(dataDir, 'runtime.lock'));
    process.once('exit', instanceLock.releaseOnExit);
    // Reconcile half-cancelled task state (orphaned dispatch items, stale
    // conversation slots, zombie schedule entries) at startup and every minute.
    // This belongs to the Server lifecycle only: `help`, `server status` and
    // `maintenance` must never enter the writable repair path from a status
    // read (2026-10-23 review §3 A2/A3). See
    // docs/plans/2026-09-03-feishu-task-execution-incident-review.md.
    const { startServerStateReconciler } = await import('./server-lifecycle-maintenance.js');
    await startServerStateReconciler({
      installRoot: paths.root,
      print: line => console.log(`[reconciler] ${line}`),
      onError: error => console.error(`[reconciler] reconciliation failed: ${errorStack(error)}`),
    });
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
  // 待激活 Provider 暂存区：用户在设置页填好 Provider 但还没点"保存并激活"时，
  // 这些事实只存在于浏览器内存里。这里让需要调用模型的辅助功能在等待激活
  // 期间也能工作——端点来自本机落盘数据，密钥仍走凭据库。
  const pendingProviderStore = new FilePendingProviderStore(accountPaths.config);
  const recovery = await configurationRepository.recover();
  if (recovery.status === 'empty') {
    // 容器直跑镜像（ADR-0055）：全新 PVC 上没有 active 配置，播种最小配置后正常
    // 启动。显式环境开关——原生路径没有它，保持"提示先运行 install"行为不变。
    if (containerBootstrapRequested(process.env)) {
      const bootstrapService = new ConfigurationService({
        repository: configurationRepository,
        renderer: new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime')),
        // 直通 probe：占位 Provider 无有效凭据，真探测必然失败；见
        // bootstrapContainerConfiguration 的注释。
        probe: async () => ({ ok: true, issues: [] }),
        createRevisionId: () => createConfigurationRevisionId(
          'bootstrap', new Date().toISOString(),
        ),
      });
      const bootstrap = await bootstrapContainerConfiguration(bootstrapService);
      console.log(`[bootstrap] 容器首启配置已播种：${bootstrap.revisionId}`);
    } else {
      throw new Error('active configuration is missing; run `anyfusion-install install`');
    }
  }
  const migratedSnapshot = await configurationRepository.getActiveSnapshot();
  const config = buildApplicationConfig(migratedSnapshot);
  // 容器自愈：引导播种的占位 Provider 是 enabled 的，凭据缺失会被启动期解析
  // 失败关断（崩溃循环）。每次容器启动补写任何 enabled Provider 缺失的凭据；
  // 补写的是明确占位值（针对它的调用得到供应商 401，可在设置页替换），
  // 绝不覆盖已存在的非空凭据。必须发生在 Planner 绑定解析凭据之前。
  if (containerBootstrapRequested(process.env)) {
    const bootstrapSecrets = createProductionSecretStore({ credentialsFile: paths.credentials });
    await prepareProductionSecretStore(bootstrapSecrets);
    const healed = await ensureBootstrapProviderCredentials({
      config: migratedSnapshot.config,
      secretStore: bootstrapSecrets,
    });
    if (healed.length > 0) {
      console.log(`[bootstrap] 占位凭据已自愈：${healed.join(', ')}`);
    }
  }
  // The legacy Markdown preview server served copies under the internal
  // workspace store. Delivery now writes into the user Workspace (ADR-0050), so
  // no Server-wide root is authorized to serve; clients use the Workspace
  // artifact preview instead. The retired setting is reported instead of
  // silently exposing internal execution paths.
  if (config.integrations?.markdown_preview?.enabled) {
    console.log(
      'Markdown preview server is retired: use the Workspace artifact preview (ADR-0050).',
    );
  }

  // 3. Bind Planner, Kernel and Runtime to the exact active revision.
  const legacySecretStore = createLegacyProductionSecretStore({
    secretsRoot: accountPaths.secrets,
    env: process.env,
    references: Object.values(migratedSnapshot.config.providers)
      .map(provider => provider.apiKeyRef),
  });
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
  await prepareProductionSecretStore(secretStore);
  await importLegacyProviderCredentials({
    target: secretStore,
    providers: migratedSnapshot.config.providers,
    legacyStore: legacySecretStore,
  });
  await importLocalAgentCredentials({
    ...localAgentCredentialSources(),
    providers: migratedSnapshot.config.providers,
    secretStore,
  });
  const officialServiceClient = new OfficialServiceClient({
    baseUrl: process.env.METAWORK_OFFICIAL_SERVER_URL ?? DEFAULT_OFFICIAL_SERVICE_URL,
  });
  const officialAuthorization = new LocalAuthorizationService({
    client: officialServiceClient,
    hasActiveWork: () => Boolean(accountRuntimeComposition?.accountRuntime.getConfigurationActivationFacts().activeTaskId),
    hasUnfinishedWork: () => Boolean(accountRuntimeComposition?.accountRuntime.getConfigurationActivationFacts().unfinishedWork.count),
    hasUnsettledWork: () => {
      const facts = accountRuntimeComposition?.accountRuntime.getConfigurationActivationFacts();
      return Boolean(facts?.plannerTurnActive || facts?.pendingWorkRequestCount || facts?.activeLeaseCount || facts?.publicationPending);
    },
  });
  // 能力说明生成与模型资料提炼优先使用用户已配置模型（本地直调其
  // Provider），官方内置 AI 仅作兜底；未固定模型或本地失败时保持原有
  // 官方路径。
  const readProviderCredential = async (reference: string): Promise<string | null> => {
    try {
      assertSecretReference(reference);
    } catch {
      return null;
    }
    const value = await secretStore.get(reference).catch(() => null);
    return value && value.trim() ? value.trim() : null;
  };
  const internalLlm = new InternalLlmService({
    officialAi: input => officialAuthorization.callOfficialAi(input.operation, input.input, input.requestId),
    preferredModel: async input => {
      const snapshot = await configurationService.getActiveSnapshot();
      // 可用 Provider = 已激活配置 ∪ 待激活暂存区。已激活优先（它是权威事实）。
      const providers = await resolvePreferredProviders(snapshot.config.providers, pendingProviderStore);
      // 调用方显式指定的用户已配置模型（模型资料提炼）：直接使用该
      // Provider 通道。解析不到就如实呈现，不静默回退官方内置 AI 掩盖
      // 配置缺失。
      if (input.preferredModel) {
        return resolvePreferredModel({
          reference: input.preferredModel,
          providers,
          readCredential: readProviderCredential,
        });
      }
      if (input.operation !== 'capability_explanation') return null;
      const facts = (input.data as { models?: Array<{ modelRef?: string; modelId?: string; providerRef?: string }> } | null)?.models ?? [];
      const usable: { baseUrl: string; apiKey: string; modelId: string }[] = [];
      const wanted: string[] = [];
      for (const fact of facts) {
        if (fact.modelId) wanted.push(fact.modelId);
        // 优先用调用方给出的 Provider 引用（编辑态的模型尚未进入已激活配置，
        // 无法从 modelRef 反查 Provider）。
        const providerRef = fact.providerRef
          ?? (fact.modelRef ? snapshot.config.models[fact.modelRef]?.providerRef : undefined);
        if (!providerRef) continue;
        const provider = providers[providerRef];
        if (!provider?.enabled || provider.protocol !== 'openai-compatible') continue;
        try {
          assertSecretReference(provider.apiKeyRef);
        } catch {
          continue;
        }
        const apiKey = await secretStore.get(provider.apiKeyRef).catch(() => null);
        if (!apiKey) continue;
        usable.push({ baseUrl: provider.baseUrl, apiKey, modelId: fact.modelId ?? providerRef });
      }
      // 用户固定了模型但没有任何一条可用凭证：这是用户可操作的配置问题，
      // 如实呈现，而不是静默回退官方内置 AI 掩盖配置缺失。
      if (facts.length > 0 && usable.length === 0) {
        throw new PreferredModelError(
          `固定模型（${wanted.join('、') || '未识别'}）尚不可用：请在模型设置中保存并激活对应 Provider`
          + '（未激活时该模型的 API Key 不会入库），或改选已配置凭证的模型。',
        );
      }
      return usable[0]
        ? { ...usable[0], system: CAPABILITY_EXPLANATION_PROMPT }
        : null;
    },
  });
  const settingsAssistant = new SettingsAssistant(internalLlm);
  const modelRoutingProfiles = new ModelRoutingProfileService(internalLlm);
  const agentCapabilityDescriptions = new AgentCapabilityDescriptionService(internalLlm);
  const renderer = new AgentRuntimeRenderer(resolve(accountPaths.generated, 'agent-runtime'));
  // Refresh revision-scoped runtime artifacts on startup so existing active
  // revisions also receive newly introduced per-Executor manuals.
  await renderer.render(migratedSnapshot);
  /**
   * Re-renders the Manager's Pi configuration after an activation so a model or
   * provider change reaches the next planning turn without a restart. Secrets are
   * resolved per activation; a missing key leaves that provider out instead of
   * writing an empty credential.
   */
  const refreshManagerProviderConfiguration = async (
    snapshot: { revisionId: string; config: AnyFusionConfigurationV2 },
    agentClassRef: string | undefined,
  ): Promise<void> => {
    if (resolvePlanningTransport(process.env) !== 'upstream-pi') return;
    const apiKeys: Record<string, string> = {};
    for (const [providerRef, provider] of Object.entries(snapshot.config.providers)) {
      if (!provider.enabled) continue;
      const value = await readProviderSecret(secretStore, provider.apiKeyRef);
      if (value) apiKeys[providerRef] = value;
    }
    writeManagerProviderConfig({
      configDir: resolve(accountPaths.root, 'manager', 'config'),
      configuration: snapshot.config,
      agentClassId: agentClassRef ?? 'planner',
      providerSecrets: managerProviderEnv(snapshot.config, apiKeys),
    });
    if (managerTransport) {
      // Composition retains this object. Replace its values so each new child
      // receives current keys, including removals, rather than startup secrets.
      managerTransport.providerConfig.configuration = snapshot.config;
      managerTransport.providerConfig.agentClassId = agentClassRef ?? 'planner';
      managerTransport.providerConfig.apiKeys = apiKeys;
    }
  };

  /** Reads one provider key, tolerating a missing or invalid reference. */
  async function readProviderSecret(
    store: SecretStore,
    reference: string,
  ): Promise<string | null> {
    try {
      assertSecretReference(reference);
      const value = await store.get(reference);
      return value.trim() ? value : null;
    } catch {
      return null;
    }
  }

  const stagedConfiguration = buildStagedLegacyConfiguration({ migratedSnapshot });
  // The Manager renders its own models.json/settings.json from the active
  // revision, so it needs provider keys resolved through the same names.
  const activeProviderKeys: Record<string, string> = {};
  for (const [providerRef, provider] of Object.entries(stagedConfiguration.snapshot.config.providers)) {
    if (!provider.enabled) continue;
    const value = await readProviderSecret(secretStore, provider.apiKeyRef);
    if (value) activeProviderKeys[providerRef] = value;
  }
  // Keep the Manager's Pi configuration in step with the active revision before
  // the first planning turn, not only after an activation.
  if (resolvePlanningTransport(process.env) === 'upstream-pi') {
    writeManagerProviderConfig({
      configDir: resolve(accountPaths.root, 'manager', 'config'),
      configuration: stagedConfiguration.snapshot.config,
      agentClassId: stagedConfiguration.plannerBinding?.agentClassRef ?? 'planner',
      providerSecrets: managerProviderEnv(stagedConfiguration.snapshot.config, activeProviderKeys),
    });
  }
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
      previousSnapshot: () => configurationRepository.getActiveSnapshot(),
    }),
  });
  const runtimeBindings = createProductionRuntimeBindings({
    snapshot: migratedSnapshot,
    secretStore,
    getSnapshot: revisionId => configurationRepository.readSnapshot(revisionId),
  });
  const db = createDatabase(accountPaths.database);
  const meteringServices = createServerMeteringServices(db);
  const usageRecorder = createUsageRecorder({ metering: meteringServices.metering });
  const resolveUsagePayer = createUsagePayerResolver(runtimeBindings.getRuntimeConfiguration);
  const quotaCatalog: readonly PlanQuotaDefinition[] = DEFAULT_PLAN_QUOTA_CATALOG;
  const hostedPlanId = (): string => {
    const plan = officialAuthorization.getStatus().entitlement?.plan;
    return plan === 'monthly'
      ? 'included-monthly'
      : plan === 'annual'
        ? 'included-yearly'
        : plan === 'trial'
          ? 'trial'
          : plan === 'internal_perpetual' ? 'included-yearly' : 'free-baseline';
  };
  const quotaContext = (now = new Date()) => {
    const planId = hostedPlanId();
    const entitlement = officialAuthorization.getStatus().entitlement;
    const trialStartedAt = planId === 'trial' && entitlement?.effectiveAt
      ? new Date(entitlement.effectiveAt) : undefined;
    return readAccountTokenQuota({ accountId: LOCAL_DEFAULT_ACCOUNT_ID, usage: meteringServices.tokenUsage,
      catalog: quotaCatalog, planId, now, ...(trialStartedAt ? { trialStartedAt } : {}) });
  };
  const quotaGuidance = () => quotaContext().quota;
  const managerBeforeModelCall = createManagerQuotaPreflight({
    loadConfiguration: runtimeBindings.loadConfigurationSnapshot,
    resolveUsagePayer,
    readDecision: () => {
      const entitlement = officialAuthorization.getStatus().entitlement;
      const planId = hostedPlanId();
      const now = new Date();
      const trialStartedAt = planId === 'trial' && entitlement?.effectiveAt
        ? new Date(entitlement.effectiveAt) : undefined;
      return decideHostedQuota({
        catalog: quotaCatalog, planId, now,
        ...(trialStartedAt ? { trialStartedAt } : {}),
        usage: quotaContext(now).usage,
      });
    },
    onNotice: (purpose, decision) => {
      console.warn(`[quota] Manager ${purpose} continues after ${decision.reason}: ${decision.usedTokens}/${decision.limit}`);
    },
  });
  const configurationRevisionRepo = new ConfigurationRevisionRepo(db);
  ensureActiveConfigurationRevision(db, {
    revisionId: migratedSnapshot.revisionId,
    contentHash: migratedSnapshot.contentHash,
  });

  // 4b. Long-term memory (optional capability).
  //
  // When memory is disabled there is no sidecar, no request, no model cost and
  // no index. The extraction credential is read from the SecretStore and
  // injected into the sidecar environment only; it never enters the Server's
  // own process.env, which the Planner process tree inherits.
  // The managed memory engine is part of the active application release.
  // `paths.root` is the persistent data/install root (for example
  // `~/.metawork`), while installers place release artifacts under
  // `paths.appCurrent`. Resolving from the former makes a packaged Server
  // report the engine as missing even when `app/current/memory/tdai` exists.
  // Keep the explicit `METAWORK_MEMORY_SIDECAR_DIR` override supported by the
  // resolver, and use the active release as the managed default.
  const sidecarResolution = resolveMemorySidecarCommand({ installRoot: applicationRoot });
  const memoryRuntimeController = await MemoryRuntimeController.create({
    configuration: migratedSnapshot.config,
    options: {
      accountId: LOCAL_DEFAULT_ACCOUNT_ID,
      db,
      secretStore,
      dataDir: accountPaths.memory,
      sidecarCommand: sidecarResolution.command,
      sidecarUnavailableReason: sidecarResolution.reason ?? 'memory_engine_unreachable',
      logger: message => console.error(`[memory] ${message}`),
      // Memory extraction is a real model call owned by the engine; it is
      // attributed to one account-level system Query and paid by the extraction
      // Provider's ownership (official → Included, user key → on-demand).
      getConfigurationRevision: () => stagedConfiguration.snapshot.revisionId,
      usageObserver: event => usageRecorder.record(event),
      resolveUsagePayer,
      queryLifecycle: meteringServices.lifecycle,
    },
  });
  console.log(`[memory] ${describeMemoryStatus(memoryRuntimeController.status)}`);

  // A stable handle for execution evidence. The controller rebuilds the runtime
  // when the memory section of the active revision changes, so the attempt
  // runner must not capture one runtime instance (review P1-1).
  const memoryEvidenceProxy = {
    collectMemoryRefs: MemoryEvidenceService.collectMemoryRefs,
    async materialize(input: {
      accountId: string;
      taskId: string;
      conversationId?: string;
      memoryIds: readonly ({ memoryId: string; revision?: string } | string)[];
    }) {
      const evidence = memoryRuntimeController.runtime.evidence;
      if (!evidence) {
        // Memory is off or degraded; report it per reference instead of
        // silently dropping the requirement.
        return {
          materialized: [] as string[],
          failed: input.memoryIds.map(value => ({ memoryId: typeof value === 'string' ? value : value.memoryId, reason: 'memory_unavailable' })),
        };
      }
      return evidence.materialize(input);
    },
  };

  // 4. 初始化 Repos
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 7. Executor availability is resolved at dispatch time by the selected
  // backend. Startup keeps direct reply/query/planning available even when
  // the configured Executor runtime is unavailable.

  // 8. 初始化上下文召回器
  const sessionId = `sess_${nanoid(10)}`;
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
      referenceHistory: true,
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
  const workspaceGitServices = () => {
    if (!accountRuntimeComposition) throw new Error('account_runtime_unavailable');
    return accountRuntimeComposition.accountRuntime.workspaceServices;
  };
  const workspaceDirectory = new WorkspaceDirectoryService({
    gitLifecycle: {
      initialize: input => workspaceGitServices().conversationWorktrees.initialize(input),
      beginInitialize: input => workspaceGitServices().conversationWorktrees.beginInitialize(input),
      state: workspaceId => workspaceGitServices().conversationWorktrees.state(workspaceId),
      error: workspaceId => workspaceGitServices().conversationWorktrees.error(workspaceId),
      beginCleanup: conversationId => workspaceGitServices().conversationWorktrees.beginCleanup(conversationId),
      prepareConversation: async input => {
        const service = workspaceGitServices().conversationWorktrees;
        return service.prepareTurn(await service.initialize(input), input.conversationId);
      },
      requestCleanup: id => workspaceGitServices().conversationWorktrees.requestCleanup(id),
    },
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    workspaceCatalog: workspaceCatalogStore,
    conversationStore,
    workspaceRoot,
    projection: directoryProjection,
    runtimeRoot: paths.root,
    workspaceStoreRoot: accountPaths.workspaceStore,
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
  // ADR-0055 D6: the Manager plans from the Conversation's user Workspace.
  // Its own inspection surface stays read-only in the Manager extension, but
  // that is not a Workspace fact: Task writes happen in the Conversation Git
  // worktree and are merged back by the Runtime. Never project a 只读/可写
  // Workspace label into the Manager turn (2026-11-11).
  const resolveManagerScope = async (
    conversationId: string,
  ): Promise<{ workspaceRoot: string; permissionProfileRef: string }> => {
    const metadata = await conversationStore.readMetadata(conversationId);
    const workspaceId = metadata?.workspaceBinding?.workspaceId;
    const workspace = workspaceId ? await workspaceCatalogStore.findById(workspaceId) : null;
    return {
      workspaceRoot: workspace?.canonicalPath ?? accountPaths.workspaceStore,
      permissionProfileRef: stagedConfiguration.plannerBinding?.permissionProfileRef ?? 'engineering',
    };
  };
  const managerTransport = resolvePlanningTransport(process.env) === 'upstream-pi'
    ? {
      runtimeRoot: accountPaths.root,
      moduleRoot: applicationRoot,
      mcpEnv: {
        METACLAW_DB_PATH: accountPaths.database,
        ANYFUSION_ACCOUNT_CONFIG_ROOT: accountPaths.config,
        METACLAW_ACCOUNT_ID: LOCAL_DEFAULT_ACCOUNT_ID,
      },
      resolveScope: (context: import('../planning/planning-types.js').PlanningContext) =>
        resolveManagerScope(context.request.conversationId ?? context.request.sessionId),
      beforeModelCall: async (context: import('../planning/planning-types.js').PlanningContext, stage: 'planning' | 'permission') => {
        await managerBeforeModelCall(context, stage);
        if (context.replan) await memoryRuntimeController.runtime.refreshRecall({
          accountId: LOCAL_DEFAULT_ACCOUNT_ID,
          conversationId: context.request.conversationId ?? context.request.sessionId,
          query: context.userInput,
        });
      },
      resolvePermissionContext: createManagerPermissionContextResolver({
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        readFacts: request => {
          const composition = accountRuntimeComposition;
          if (!composition) return null;
          const runtime = composition.accountRuntime;
          const task = taskEngine.getTaskRepo().findById(request.taskId);
          const subtask = runtime?.repositories.subtaskRepo.findById(request.subtaskId);
          const graph = runtime?.repositories.workGraphRevisionRepo.findActive(request.taskId);
          const attempt = runtime?.runtimeExecutionServices?.dispatchItemRepo.find(request.attemptId);
          if (!task || !subtask || !graph || !attempt) return null;
          return { task, subtask, graph, attempt: {
            ...attempt,
            agentClassRef: attempt.authorizedBinding.agentClassRef,
            permissionProfileId: composition.executionRuntime.resolvePermissionProfile(attempt.authorizedBinding),
          } };
        },
        readUserIntent: (taskId, conversationId) => {
          const queries = meteringServices.contexts.listQueryIdsForTask(taskId)
            .map(queryId => meteringServices.contexts.findById(queryId))
            .filter(query => query?.accountId === LOCAL_DEFAULT_ACCOUNT_ID
              && query.conversationId === conversationId && query.turnId);
          const source = queries[0];
          if (!source?.turnId) return null;
          const turns = new SqliteConversationTurnStore(db);
          if (turns.deletionState(LOCAL_DEFAULT_ACCOUNT_ID, conversationId)) return null;
          const turn = turns.find({ accountId: LOCAL_DEFAULT_ACCOUNT_ID, conversationId, turnId: source.turnId });
          if (!turn) return null;
          return { queryId: source.queryId, text: turns.readBody(LOCAL_DEFAULT_ACCOUNT_ID, turn.input.hash).text };
        },
        readConfiguration: async revision => buildPlannerConfigurationView(await runtimeBindings.loadConfigurationSnapshot(revision)),
        onUsage: createManagerPermissionUsageRecorder({ recorder: usageRecorder, resolveUsagePayer }),
      }),
      // The Manager must be told the canonical Plan contract; it is generated
      // from the same schema that validates the proposal.
      explicitEnv: {
        METAWORK_MANAGER_PLAN_SCHEMA: resolvePlanSchemaPath(applicationRoot),
      },
      providerConfig: {
        configuration: stagedConfiguration.snapshot.config,
        agentClassId: stagedConfiguration.plannerBinding?.agentClassRef ?? 'planner',
        apiKeys: activeProviderKeys,
      },
      ...(process.env.METAWORK_PI_COMMAND ? { piCommand: process.env.METAWORK_PI_COMMAND } : {}),
    }
    : undefined;
  const executorManualPreview = new ExecutorManualPreviewService(configurationService);
  const taskArtifactRepo = new TaskArtifactRepo(db);

  // ADR-0031: 组合根构造 RuntimeRegistry + AccountRuntime（local-default），
  // 会话工厂复用 AccountRuntime 的账户级服务簇。
  const resolveTaskWorkspacePath = async (taskId: string): Promise<string | null> => {
    const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as
      { workspace_id: string | null } | undefined;
    if (!task?.workspace_id) return null;
    const workspace = await workspaceCatalogStore.findById(task.workspace_id);
    return workspace && workspace.availability === 'available' ? workspace.canonicalPath : null;
  };
  const managedLocalServices = new ManagedLocalServices({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    store: new ManagedLocalServiceRepo(db, LOCAL_DEFAULT_ACCOUNT_ID),
    logRoot: resolve(accountPaths.attempts, '..', 'managed-services'),
    resolveEnvironment: async reference => {
      try { assertSecretReference(reference); return await secretStore.get(reference); } catch { return null; }
    },
    isPublishedServiceSpecification: async (taskId, root, relativePath) => {
      const source=workspaceGitServices().workspaceGitRepo.sourceForTask(taskId);
      if(source) {
        return workspaceGitServices().serviceWorktrees.containsPublishedFile(taskId, root, relativePath);
      }
      const published = taskArtifactRepo.publicFiles.list(LOCAL_DEFAULT_ACCOUNT_ID, taskId)
        .some(item => item.status === 'published' && item.relativePath === relativePath
          && item.publishedPath === join(root, relativePath));
      if (published) return true;
      // A historical single-root Task has no publication rows. Their declared
      // write targets are the provenance boundary: a Workspace-root manifest
      // that was not part of this Task's target cannot be silently adopted.
      const task = taskEngine.getTaskRepo().findById(taskId);
      if (!task) return false;
      return (task.workspaceTargetPaths ?? []).some(target => {
        const normalized = target.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
        return normalized === '' || relativePath === normalized || relativePath.startsWith(`${normalized}/`);
      });
    },
    resolveWorkspaceId: async taskId => {
      const row = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as
        { workspace_id: string | null } | undefined;
      return row?.workspace_id ?? null;
    },
    // The Task's delivered files are the durable facts that identify which
    // project a follow-up run targets. They keep an old Workspace-root service
    // specification from becoming the target of a newly delivered project.
    listTaskArtifactPaths: async taskId => taskArtifactRepo.publicFiles
      .list(LOCAL_DEFAULT_ACCOUNT_ID, taskId)
      .filter(item => item.status === 'published')
      .map(item => item.relativePath),
    listTaskTargetPaths: async taskId => taskEngine.getTaskRepo().findById(taskId)?.workspaceTargetPaths ?? [],
    prepareServiceDirectory: async (taskId,serviceId,projectPath) => {
      const services=workspaceGitServices().serviceWorktrees;
      const record=await services.prepare(taskId,serviceId,projectPath);
      return {...record,needsPreparation:!services.isPrepared(record)};
    },
    onServiceChanged: async record => workspaceGitServices().serviceWorktrees.observe(record),
    resolvePublishedDirectory: async taskId => {
      const task = taskEngine.getTaskRepo().findById(taskId);
      if (!task || task.accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return null;
      if(workspaceGitServices().workspaceGitRepo.sourceForTask(taskId)) {
        return (await workspaceGitServices().serviceWorktrees.prepare(taskId,`discovery_${taskId}`)).rootPath;
      }
      const workspace = await resolveTaskWorkspacePath(taskId);
      if (!workspace) return null;
      const canonicalWorkspace = await realpath(workspace);
      // A published project is runnable without a service manifest. The file
      // registry proves that this Task delivered something into the Workspace;
      // target resolution then selects the project's own path and optionally
      // discovers its launch command.
      const publishedFiles = taskArtifactRepo.publicFiles.list(LOCAL_DEFAULT_ACCOUNT_ID, taskId)
        .filter(item => item.status === 'published');
      return publishedFiles.length > 0 ? canonicalWorkspace : null;
    },
  });
  await managedLocalServices.recover();
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
      if (!span?.enabled) return null;
      try {
        if (span.providerRef && span.modelRef) {
          const provider = snapshot.config.providers[span.providerRef];
          const model = snapshot.config.models[span.modelRef];
          if (!provider || !model || !provider.enabled || !model.enabled || model.providerRef !== span.providerRef) return null;
          assertSecretReference(provider.apiKeyRef);
          return (await secretStore.get(provider.apiKeyRef)).trim() || null;
        }
        if (span.apiKeyRef !== SPAN_ROUTING_SECRET_REFERENCE) return null;
        return (await secretStore.get(SPAN_ROUTING_SECRET_REFERENCE as SecretReference)).trim() || null;
      } catch { return null; }
    },
    resolveBaseUrl: async revisionId => {
      const snapshot = await configurationService.getSnapshot(revisionId);
      const span = snapshot.config.routing?.span;
      if (span?.providerRef && span.modelRef) return snapshot.config.providers[span.providerRef]?.baseUrl ?? null;
      return 'https://openrouter.ai/api/v1';
    },
    resolveDecisionModels: async revisionId => {
      const snapshot = await configurationService.getSnapshot(revisionId);
      const span = snapshot.config.routing?.span;
      if (!span?.enabled) return [];
      // Keep the pre-Provider OpenRouter setting readable while all new
      // settings use the same Provider/Model path as agents.
      if (!span.providerRef || !span.modelRef) {
        if (span.apiKeyRef !== SPAN_ROUTING_SECRET_REFERENCE) return [];
        try {
          const apiKey = (await secretStore.get(SPAN_ROUTING_SECRET_REFERENCE as SecretReference)).trim();
          return apiKey ? [{
            model: span.model ?? '',
            apiKey,
            baseUrl: 'https://openrouter.ai/api/v1',
          }] : [];
        } catch {
          return [];
        }
      }
      const refs = [span.modelRef, ...(span.fallbackModelRefs ?? [])];
      const resolved: Array<{
        model: string;
        apiKey: string;
        baseUrl?: string;
      }> = [];
      for (const modelRef of refs) {
        const model = snapshot.config.models[modelRef];
        const provider = model ? snapshot.config.providers[model.providerRef] : undefined;
        if (!model || !provider || !provider.enabled || !model.enabled) continue;
        try {
          assertSecretReference(provider.apiKeyRef);
          const apiKey = (await secretStore.get(provider.apiKeyRef)).trim();
          if (!apiKey) continue;
          if (!isSystemOneDecisionModel({
            modelId: model.modelId,
            baseUrl: provider.baseUrl,
            outputModalities: model.publicFacts?.outputModalities,
            description: model.description,
          })) continue;
          resolved.push({
            model: model.modelId,
            apiKey,
            baseUrl: provider.baseUrl,
          });
        } catch {
          // An unavailable fallback is omitted; the advisor tries the next one.
        }
      }
      return resolved;
    },
    lifetimeSignal: spanRoutingShutdown.signal,
  });
  const recoveryPlan = (context: import('../planning/planning-types.js').PlanningContext) => {
    // The recovery path runs on the same planning transport as the foreground:
    // Manager by default, no client attached either way.
    const planningAgent = accountRuntimeComposition?.plannerServices?.planningAgent;
    if (!planningAgent) throw new Error('recovery planning requires a planning agent');
    return planWithoutClient({
      context,
      planningAgent,
      signal: spanRoutingShutdown.signal,
    });
  };
  const recoveryReplan = createRecoveryReplanner({
    db,
    getPort: () => accountRuntimeComposition!.runtimePort,
    getSnapshot: revisionId => configurationService.getSnapshot(revisionId),
    signal: spanRoutingShutdown.signal,
    plan: recoveryPlan,
    // A recovery replan is client-less: its Workspace admission comes from the
    // Task's own durable binding, never from a connected client's selection.
    resolveTaskWorkspace: async task => {
      if (!task.workspaceId) return null;
      const workspace = await workspaceCatalogStore.findById(task.workspaceId);
      if (!workspace || workspace.archived || workspace.availability !== 'available') return null;
      return { workspaceId: workspace.id, canonicalPath: workspace.canonicalPath };
    },
    getSessionControlRuntime: () => (
      (accountRuntimeComposition as unknown as {
        kernelExecutionServices?: { sessionControlRuntime: import('../session/session-control-runtime.js').SessionControlRuntime };
      } | null)?.kernelExecutionServices?.sessionControlRuntime ?? null
    ),
  });
  let conversationRegistry: ConversationRegistry | null = null;
  accountRuntimeComposition = buildAccountRuntimeComposition({
    managedLocalServices,
    recoveryReplan,
    recoveryPlan,
    resolveConfigurationSnapshot: runtimeBindings.loadConfigurationSnapshot,
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    db,
    taskEngine,
    resolveWorkspacePath: resolveTaskWorkspacePath,
    preflightWorkspacePath: path => workspaceDirectory.preflightPath(path),
    productionAuthorization: () => {
      // Local acceptance only: lets an operator drive a real Turn end to end
      // without an official-account login. Refused in production builds.
      if (process.env.METAWORK_ACCEPTANCE_AUTHORIZATION === '1'
        && process.env.NODE_ENV !== 'production') {
        return { allowed: true };
      }
      const status = officialAuthorization.getStatus();
      return status.state === 'active'
        ? { allowed: true }
        : { allowed: false, reason: status.reason ?? `official authorization state: ${status.state}` };
    },
    orchestration,
    // Evidence delivery resolves the live runtime on every reference, so a
    // configuration activation that rebuilds the memory runtime keeps working.
    memoryEvidence: memoryEvidenceProxy,
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
    spanRoutingEvaluator: spanRoutingAdvisor,
    getRuntimeBinding: runtimeBindings.getRuntimeBinding,
    getRuntimeConfiguration: runtimeBindings.getRuntimeConfiguration,
    getActiveRuntimeConfiguration: runtimeBindings.getActiveRuntimeConfiguration,
    configurationActivationGate,
    ...(managerTransport ? { managerTransport } : {}),
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
    usageSpanCloser: (spanId, state, closedAt) => meteringServices.metering.closeSpan(spanId, state, closedAt),
    usagePayer: 'unknown',
    resolveUsagePayer,
    queryUsageLifecycle: meteringServices.lifecycle,
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
    prepareConfig: async ({ config, secrets, spanApiKey }) => {
      const prepared = structuredClone(config) as AnyFusionConfigurationV2;
      for (const [providerRef, apiKey] of Object.entries(secrets)) {
        const reference = `file-secret:anyfusion/providers/${providerRef}` as const;
        const provider = prepared.providers[providerRef];
        if (provider) provider.apiKeyRef = reference;
      }
      if (spanApiKey !== undefined) {
        // Only the credential reference is persisted. A later enable/disable
        // toggle reuses the same reference without re-entering the key.
        const existingSpan = prepared.routing?.span;
        prepared.routing = {
          ...prepared.routing,
          span: {
            enabled: existingSpan?.enabled ?? false,
            ...(existingSpan?.model ? { model: existingSpan.model } : {}),
            ...(existingSpan?.providerRef ? { providerRef: existingSpan.providerRef } : {}),
            ...(existingSpan?.modelRef ? { modelRef: existingSpan.modelRef } : {}),
            ...(existingSpan?.fallbackModelRefs ? { fallbackModelRefs: [...existingSpan.fallbackModelRefs] } : {}),
            timeoutMs: existingSpan?.timeoutMs ?? SPAN_ROUTING_DEFAULT_TIMEOUT_MS,
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
      await refreshManagerProviderConfiguration(snapshot, nextStaged.plannerBinding?.agentClassRef);
      runtimeBindings.updateSnapshot(snapshot);
      stagedConfiguration.snapshot = nextStaged.snapshot;
      stagedConfiguration.planner = nextStaged.planner;
      stagedConfiguration.kernel = nextStaged.kernel;
      stagedConfiguration.plannerBinding = nextStaged.plannerBinding;
      stagedConfiguration.plannerBindingFingerprint = nextStaged.plannerBindingFingerprint;
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
      // Long-term memory is a revisioned setting (design §7). Applying it here
      // is what makes the settings switch actually take effect: the controller
      // rebuilds the runtime only when the memory section changed, draining the
      // pending segment first (review P1-1, P1-2).
      try {
        const applied = await memoryRuntimeController.applyConfiguration(snapshot.config);
        if (applied.rebuilt) {
          console.log(
            `[memory] reconfigured: ${describeMemoryStatus(applied.status)}`
            + (applied.flushed > 0 ? ` (flushed ${applied.flushed} turn messages)` : ''),
          );
          if (applied.error) console.warn(`[memory] reconfigure degraded: ${applied.error}`);
        }
      } catch (error) {
        // A memory failure must never fail a configuration activation: the
        // revision is already committed and every other section applied.
        console.error(`[memory] reconfigure failed: ${(error as Error).message}`);
      }
      republishAgentReadiness?.();
    },
    onActivationFailed: async ({ snapshot, runtime }) => {
      const restored = buildStagedLegacyConfiguration({ migratedSnapshot: snapshot });
      await refreshManagerProviderConfiguration(snapshot, restored.plannerBinding?.agentClassRef);
      runtimeBindings.updateSnapshot(snapshot);
      stagedConfiguration.snapshot = restored.snapshot;
      stagedConfiguration.planner = restored.planner;
      stagedConfiguration.kernel = restored.kernel;
      stagedConfiguration.plannerBinding = restored.plannerBinding;
      stagedConfiguration.plannerBindingFingerprint = restored.plannerBindingFingerprint;
      await gatewayFeishuManager?.applyConfiguration(buildApplicationConfig(snapshot));
      // A failed activation restores the previous revision, so the memory
      // runtime must follow it back (review P1-1).
      try {
        await memoryRuntimeController.applyConfiguration(snapshot.config);
      } catch (error) {
        console.error(`[memory] restore after failed activation failed: ${(error as Error).message}`);
      }
      republishAgentReadiness?.();
    },
  });
  const agentReadiness = new AgentInstallationReadinessService({
    requiredAgentIds: () => ['pi-agent'],
    resolveCommand: definition => {
      const harness = Object.values(configurationRuntimeCoordinator.getSnapshot().config.harnesses)
        .find(harness => harness.driverId === 'pi-cli' && harness.transport === 'local-cli');
      const command = resolveExecutorTool(harness?.transport === 'local-cli' ? harness.command : definition.command,
        { releaseRoot: applicationRoot });
      return { command, managed: definition.agentId === 'pi-agent' && Boolean(process.env.METAWORK_MANAGED_PI
        || command.includes('/desktop-tools/executor/') || command.includes('.tools/executor/')) };
    },
    probe: defaultVersionProbe,
    // Installation belongs to the shared tool, not one arbitrarily chosen assistant.
    resolveDisplayName: () => 'Pi',
  });
  republishAgentReadiness = () => { void agentReadiness.refresh({ force: true }).catch(() => undefined); };
  const runtimePort = activatedAccountRuntime.getConversationPort();
  conversationRegistry = new ConversationRegistry();

  const commandCatalog = createDefaultCommandCatalog();

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
      // Runtime-owned write readiness: a failed Workspace Git root fails plan
      // admission with its own reason instead of becoming a Manager question.
      resolveWorkspaceWriteState: workspaceId =>
        workspaceWriteStateOf(workspaceGitServices().conversationWorktrees.repo.root(workspaceId)),
      onBackgroundResultDelivery: async (delivery, originTurnId) => {
        if (!deliverSystemResult) throw new Error('Result delivery is unavailable');
        await deliverSystemResult(conversationId, delivery, originTurnId);
      },
      conversationId,
      plannerSessionId: conversationId,
      plannerBindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
      plannerProviderRef: stagedConfiguration.plannerBinding?.providerRef,
      plannerModelId: stagedConfiguration.plannerBinding
        ? stagedConfiguration.snapshot.config.models[stagedConfiguration.plannerBinding.modelRef]?.modelId
        : undefined,
      runtimePort: port,
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      presentation,
      sessionStateRepo,
      persistenceService,
      interactionTraceStream,
      planningContextBuilder,
      db,
      getControlConfiguration: () => stagedConfiguration.kernel,
      getRuntimeConfiguration: runtimeBindings.getRuntimeConfiguration,
      resolveConfigurationSnapshot: runtimeBindings.loadConfigurationSnapshot,
      lifetimeSignal: spanRoutingShutdown.signal,
      commandCatalog,
      commandReadServices,
      taskEngine,
      orchestration,
      config,
      plannerProposalRepo: new PlannerProposalRepo(db),
      refreshMemoryRecall: async input => {
          await memoryRuntimeController.runtime.refreshRecall({
            accountId: LOCAL_DEFAULT_ACCOUNT_ID,
            conversationId: input.conversationId,
            query: input.query,
          });
        },
      queryUsage: {
        lifecycle: meteringServices.lifecycle,
        ingress: 'tui',
        usageObserver: event => usageRecorder.record(event),
        usagePayer: 'unknown',
        resolveUsagePayer,
      },
      workspace,
      dispose: async () => undefined,
    });

    // One scoping mechanism: the Turn runs inside the Conversation's execution
    // binding, so the shared control services are used unproxied.
    const binder = accountRuntimeComposition.conversationExecutionBinder;
    const binding = {
      sessionId: conversationId,
      persistenceService,
      presentation,
      ...conversation.getControlExecutionCallbacks(),
    };
    conversation.bindControlExecutionRuntime(accountRuntimeComposition.controlExecutionServices.kernelExecutionRuntime);
    conversation.bindSessionControlRuntime(accountRuntimeComposition.controlExecutionServices.sessionControlRuntime);
    conversation.bindTaskExecutionApplicationService(
      accountRuntimeComposition.controlExecutionServices.taskExecutionApplicationService,
    );
    conversation.bindRunInBinding(operation => binder.runWith(binding, operation));

    return conversation;
  };
  const conversationBindings = new ConversationBindingRepository(
    resolve(accountPaths.gateway, 'conversation-bindings.json'),
  );
  await conversationBindings.initialize();
  const eventJournalRuntime = createAccountEventJournal({
    historyWorkerUrl: new URL('./conversation-history-worker.js', import.meta.url),
    retireLegacyFiles: async conversationId => {
      await conversationStore.retireLegacyTurns(conversationId);
      await presentationStore.retireLegacyFile(conversationId);
    },
    prepareHistory: async conversationId => {
      if (!canonicalHistory.isImported(conversationId)
        && new SqliteConversationMetadataIndex(db, LOCAL_DEFAULT_ACCOUNT_ID).find(conversationId)) {
        await conversationStore.readHistoryPage(conversationId, { limit: 1 });
      }
    },
    readModel: conversationReadModel,
    db, root: resolve(accountPaths.gateway, 'events'), accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    // The stack and the failing Conversation are what turn `Cannot read
    // properties of null` into a locatable defect (§A2/A3).
    onError: (error, context) => {
      console.error([
        'Gateway journal maintenance failed:',
        `account=${context?.accountId ?? LOCAL_DEFAULT_ACCOUNT_ID}`,
        `conversation=${context?.conversationId ?? 'unknown'}`,
        `stage=${context?.stage ?? 'unknown'}`,
        `attempts=${context?.attempts ?? 1}`,
        `suppressed=${context?.suppressed ?? 0}`,
        `outcome=${context?.outcome ?? 'reported'}`,
        errorStack(error),
      ].join(' '));
    },
    onRecovered: context => console.log(
      `Gateway journal maintenance recovered: account=${context.accountId} `
      + `conversation=${context.conversationId} failures=${context.failedAttempts} `
      + `suppressed=${context.suppressed}`,
    ),
  });
  const eventJournal = eventJournalRuntime.journal;
  const normalizeHistoryPage = (turns: readonly ConversationTurn[]): ConversationTurn[] => {
    const taskIds = [...new Set(turns.flatMap(turn => turn.taskId ? [turn.taskId] : []))];
    const aliases = new Map(new WorkGraphRevisionRepo(db).listPresentationIdentitiesByTasks(taskIds)
      .map(plan => [plan.taskId, buildCanonicalSubtaskIdentityMap(
        plan.taskId, plan.graphRevision, plan.subtaskIds.map(id => ({ id })),
      )]));
    return turns.map(turn => normalizeExecutionPresentation(turn, aliases.get(turn.taskId ?? '') ?? new Map()));
  };
  const normalizeTurnPresentation = (turn: ConversationTurn): ConversationTurn => normalizeHistoryPage([turn])[0]!;
  const deliveryResults = new ResultObjectRepo(db, accountPaths.results);
  const legacyAdmissions = new FileCommandAdmissionStore(resolve(accountPaths.gateway, 'command-admissions'));
  const conversationDeletion = new ConversationDeletionService({
    store: new SqliteConversationDeletionStore(db),
    cleanFiles: async (_accountId, conversationId) => {
      await conversationRegistry.closeForDeletion(conversationId);
      const metadata = await conversationStore.readMetadata(conversationId);
      const plannerSessions = new Set((db.prepare(`SELECT DISTINCT planner_session_id FROM planner_transcript_turns
        WHERE account_id = ? AND conversation_id = ?`).all(_accountId, conversationId) as { planner_session_id: string }[])
        .map(row => row.planner_session_id));
      if (metadata?.plannerSessionId) plannerSessions.add(metadata.plannerSessionId);
      for (const plannerSessionId of plannerSessions) {
        const path = resolve(accountPaths.plannerSessions, `${plannerSessionId}.jsonl`);
        if (dirname(path) !== resolve(accountPaths.plannerSessions)) throw new Error('invalid_planner_session_path');
        await rm(path, { force: true });
      }
      const attempts = db.prepare(`SELECT r.attempt_id FROM executor_attempt_receipts r JOIN tasks t ON t.id = r.task_id
        WHERE t.account_id = ? AND t.conversation_id = ?`).all(_accountId, conversationId) as { attempt_id: string }[];
      const materializer = new RuntimeHomeMaterializer(accountPaths.attempts);
      for (const attempt of attempts) await rm(materializer.resolvePaths(attempt.attempt_id).attemptRoot, { recursive: true, force: true });
      deliveryResults.eraseConversationContent(_accountId, conversationId);
      await legacyAdmissions.eraseConversation(_accountId, conversationId);
      await eventJournalRuntime.journal.deleteConversation(LOCAL_DEFAULT_ACCOUNT_ID, conversationId);
      await presentationStore.delete(conversationId);
      await conversationStore.eraseContent(conversationId);
      await updateConversationCatalog(conversationStore, catalog => ({ ...catalog,
        conversations: catalog.conversations.filter(item => item.id !== conversationId) }));
    },
    cleanMemory: async (accountId, conversationId) => {
      const service = memoryRuntimeController.runtime.service;
      if (service) return service.deleteConversation(accountId, conversationId);
      // Disabled Memory may have older external data; never claim it was erased.
      return !db.prepare(`SELECT 1 FROM memory_flush_state WHERE account_id = ? AND conversation_id = ? AND last_sequence > 0
        UNION ALL SELECT 1 FROM conversation_memory_attempts WHERE account_id = ? AND conversation_id = ? LIMIT 1`)
        .get(accountId, conversationId, accountId, conversationId);
    },
    onError: error => console.error(`Conversation deletion pending: ${(error as Error).message}`),
  });
  await conversationDeletion.retry(LOCAL_DEFAULT_ACCOUNT_ID);
  const webSessionCatalog = new WebSessionCatalog({
    deleteContent: conversationId => conversationDeletion.remove(LOCAL_DEFAULT_ACCOUNT_ID, conversationId),
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
        ...new SqliteTaskActivityFacts(db).read(task, permissionRequestId ? { requestId: permissionRequestId } : null),
        task: {
          id: task.id,
          status: task.status,
          stateVersion: task.stateVersion,
          stateDetail: task.stateDetail,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt ?? null,
          archivedAt: task.archivedAt ?? null,
          retryOfTaskId: task.retryOfTaskId ?? null,
        },
        subtasks: new SubtaskRepo(db).listByTask(taskId)
          .map(subtask => ({ id: subtask.id, status: subtask.status })),
        dispatches: new ControlDispatchItemRepo(db).listByTask(taskId).map(item => ({
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
        pendingDecision: new SqliteTaskActivityFacts(db).read(task, null).pendingDecision,
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
      const kind = summary.status === 'succeeded' ? 'completed'
        : summary.status === 'failed' ? 'failed'
          : summary.status === 'needs_action' ? 'approval' : null;
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
    const permissionId = pending && !new SqlitePermissionRepository(db).findResolution(pending.request.id) ? pending.request.id : null;
    const view = projectTaskView(new SqliteTaskActivityFacts(db).read(task,
      permissionId ? { requestId: permissionId } : null));
    const generation = accountRuntimeComposition.runtimePort.queries.findActiveWorkGraphRevision(task.id)?.generationId ?? `unplanned:${task.id}`;
    const progress = new SqliteConversationActivitySource(db).latestProgress(task.id, generation);
    return { taskId: task.id, title: task.title,
      executionGeneration: generation,
      graphRevision: accountRuntimeComposition.runtimePort.queries.findActiveWorkGraphRevision(task.id)?.revision,
      ...(progress ? { progressSummary: redactSensitiveText(progress).slice(0, 1024) } : {}),
      status: view.status, statusLabel: view.statusLabel,
      stateVersion: view.state.stateVersion, reason: view.state.reason,
      phase: view.state.phase, pendingActions: view.state.pendingActions,
      nextAuthorizedAction: view.nextAuthorizedAction,
      explanation: view.explanation,
      executionSettling: view.activeAttempt?.lifecycle === 'settling',
      canCancel: !isTerminalTaskStatus(view.status) };
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
    // A Turn whose Task already finished cannot still be running. Reporting the
    // truth at read time also repairs Turns left open by earlier builds; a
    // genuinely live Turn is never overridden.
    settleTurn: turn => settleObservedTurn(
      turn,
      conversationRegistry.getIfOpen(turn.conversationId)?.getInteractionTrace() ?? null,
      turn.taskId ? taskRepo.findById(turn.taskId) : null,
    ),
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
          // A pending projection still carries the committed Task conclusion;
          // only the narrative text is provisional.
          taskId: task.id,
          title: task.title,
          executionGeneration: '',
          status: task.status,
          statusLabel: TASK_STATUS_LABELS[task.status],
          stateVersion: task.stateVersion,
          reason: task.stateDetail.reason,
          phase: task.stateDetail.phase,
          pendingActions: isTerminalTaskStatus(task.status) ? [] : task.stateDetail.pendingActions,
          nextAuthorizedAction: 'none',
          explanation: '正在同步任务进度…',
          canCancel: !isTerminalTaskStatus(task.status),
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
    taskView: task => projectTaskView(new SqliteTaskActivityFacts(db).read({ ...task, updatedAt: null }, null)),
    subtaskRepo: new SubtaskRepo(db),
    receiptRepo: new ExecutorAttemptReceiptRepo(db),
    publicationRepo: new WorkspacePublicationRepo(db),
    attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db),
    dispatchItemRepo: new ControlDispatchItemRepo(db),
    configurationByRevision: timelineConfigurationByRevision,
  });
  const conversationGatewayRuntime = new ConversationGatewayRuntime({
    resultSourceTask: resultId => (db.prepare('SELECT task_id FROM result_objects WHERE result_id = ? AND account_id = ?')
      .get(resultId, LOCAL_DEFAULT_ACCOUNT_ID) as { task_id: string } | undefined)?.task_id ?? null,
    onOutboxError: error => console.error('Conversation event publication pending:', errorStack(error)),
    turnStore: new SqliteConversationTurnStore(db),
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
  let turnMaintenanceBusy = false;
  let turnMaintenanceError: string | null = null;
  const maintainTurnContent = async () => {
    if (turnMaintenanceBusy) return;
    turnMaintenanceBusy = true;
    try {
      await conversationGatewayRuntime.flushTurnOutbox();
      deliveryResults.collectReferencedContent();
      await conversationDeletion.retry(LOCAL_DEFAULT_ACCOUNT_ID);
      turnMaintenanceError = null;
    } catch (error) {
      const message = errorStack(error);
      if (message !== turnMaintenanceError) console.error('Conversation content maintenance failed:', message);
      turnMaintenanceError = message;
    } finally { turnMaintenanceBusy = false; }
  };
  await maintainTurnContent();
  const turnContentTimer = setInterval(() => { void maintainTurnContent(); }, 5_000);
  turnContentTimer.unref();
  const deliveryScheduler = new ConversationTaskSchedulerRepo(db);
  deliverSystemResult = createBackgroundResultDelivery({
    turnStore: new SqliteConversationTurnStore(db),
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    resolveTask: resultId => {
      const object = deliveryResults.findObject(resultId);
      return object?.accountId === LOCAL_DEFAULT_ACCOUNT_ID && object.kind !== 'raw_attempt_output'
        ? taskRepo.findById(object.taskId) : null;
    },
    resolveQuery: taskId => {
      const queryId = deliveryScheduler.getQueuedPayload(taskId)?.queryId
        ?? meteringServices.contexts.listQueryIdsForTask(taskId)[0];
      return queryId ? meteringServices.contexts.findById(queryId) : null;
    },
    taskForQuery: queryId => meteringServices.contexts.findTaskLink(queryId)?.taskId ?? null,
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
  for (const task of taskRepo.findByStatus('succeeded')) {
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
    merge:workspaceGitServices().workspaceMergeWorker,
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
    tokenUsage: meteringServices.tokenUsage,
    quotaGuidance,
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
      // 授权由只读查询入口完成；补全不打开会话、不启动 Planner 或创建绑定。
      if (scope.selection.mode !== 'attach') {
        return { state: 'inactive', suggestions: [], hint: null, error: null };
      }
      return commandCatalog.complete({
        text,
        cursor: cursor ?? text.length,
        context: {
          conversationId: scope.selection.conversationId,
          currentTaskId: conversationRegistry.getIfOpen(scope.selection.conversationId)?.getCurrentTaskId() ?? null,
          taskEngine,
          db,
          executorAgentClassNames: runtimePort.execution?.listExecutorAgentClassNames(),
        },
      });
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
      const queryContext = meteringServices.contexts.findByTurnId(accountId, turnId);
      const queryTaskId = queryContext?.conversationId === conversationId
        ? meteringServices.contexts.findTaskLink(queryContext.queryId)?.taskId ?? null
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
        dispatches: new ControlDispatchItemRepo(db).listByTask(taskId),
        receipts: new ExecutorAttemptReceiptRepo(db).listByTask(taskId),
        findObject: resultId => deliveryResults.findObject(resultId),
        readConfiguration: revisionId => configurationRepository.readSnapshot(revisionId),
      });
      const activeGraph = new WorkGraphRevisionRepo(db).findActive(taskId);
      const lifecycleProjection = {
        ...projectObservedTask(task, taskPermission?.request.id ?? null, executionFacts.result),
        // Bound per-Turn controls (cancel/resume) to the generation they saw.
        executionGeneration: activeGraph?.generationId ?? null,
      };
      const publicWorkspace = task.workspaceId ? await workspaceCatalogStore.findById(task.workspaceId) : null;
      const publicArtifacts = taskArtifactRepo.listByTask(taskId).filter(item => item.accountId === accountId && item.status === 'published');
      const publications = new WorkspacePublicationRepo(db);
      const publicDelivery = projectPublicDelivery({ task, workspace: publicWorkspace?.canonicalPath ?? null,
        artifacts: [...taskArtifactRepo.publicFiles.list(accountId, taskId), ...publicArtifacts],
        publications: publications.listByTask(taskId).filter(item => item.generationId === activeGraph?.generationId
          && new SubtaskRepo(db).findById(item.subtaskId)?.graphRevision === activeGraph?.revision),
        delivery: id => publications.delivery(id) });
      // Historical query fixtures and older embedded callers may not inject
      // the optional change-record repository yet. Keep that read model
      // additive: publication/task history remains queryable without it.
      const changeRecord = typeof WorkspaceChangeRecordRepo === 'undefined'
        ? null
        : new WorkspaceChangeRecordRepo(db).listByTask(taskId, 1)[0] ?? null;
      const workspaceChanges = changeRecord
        ? {
            recordId: changeRecord.recordId,
            coverage: changeRecord.coverage,
            missingReasons: changeRecord.missingReasons,
            totalFiles: changeRecord.totalFiles,
            recordedAt: changeRecord.createdAt,
            files: changeRecord.files.slice(0, 200),
          }
        : null;
      const timeline = executionProjector.project(task);
      const publicExecutors = new Map(executionFacts.subtasks.map(subtask => [subtask.id, subtask.executor]));
      for (const stage of timeline.stages) {
        for (const subtask of stage.subtasks ?? []) {
          subtask.executor = publicExecutors.get(subtask.id) ?? undefined;
        }
      }
      const workspaceMerge = accountRuntimeComposition?.accountRuntime?.workspaceServices?.workspaceGitRepo
        ?.summary(taskId, activeGraph?.generationId) ?? null;
      return {
        publicDelivery,
        workspaceId: task.workspaceId ?? null,
        workspaceMerge,
        queryVersion: GATEWAY_TASK_VIEW_QUERY_VERSION,
        requestId,
        targetConversationId: conversationId,
        turnId,
        taskId,
        title: task.title,
        status: timeline.status,
        state: lifecycleProjection.state,
        lifecycle: {
          status: lifecycleProjection.status,
          statusLabel: lifecycleProjection.statusLabel,
          stateVersion: lifecycleProjection.state.stateVersion,
          phase: lifecycleProjection.state.phase,
          reason: lifecycleProjection.state.reason,
          pendingActions: lifecycleProjection.state.pendingActions,
          cleanup: lifecycleProjection.state.cleanup,
          retryOfTaskId: lifecycleProjection.state.retryOfTaskId,
          executionGeneration: lifecycleProjection.executionGeneration,
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
        workspaceChanges,
        pendingPermission: taskPermission
          ? {
              requestId: taskPermission.request.id,
              // Same identity the approval command must carry, so an inline
              // button can approve without a second round-trip.
              requestRevision: taskPermission.request.fingerprint,
              generationId: taskPermission.request.generationId,
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
  await commandAdmissionStore.initialize(legacyAdmissions);
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
      check: async command => {
        if (command.kind === 'create_conversation') return { allowed: true };
        const acceptance = process.env.METAWORK_ACCEPTANCE_AUTHORIZATION === '1'
          && process.env.NODE_ENV !== 'production';
        const status = acceptance
          ? { state: 'active' as const }
          : await officialAuthorization.verifyForProduction();
        if (status.state !== 'active') return { allowed: false, reason: 'official_authorization_required' };
        if (!stagedConfiguration.plannerBinding) return { allowed: false, reason: 'configuration_invalid' };
        if (!Object.values(configurationRuntimeCoordinator.getSnapshot().config.agentClasses)
          .some(agent => agent.kind === 'executor' && agent.enabled)) {
          return { allowed: false, reason: 'no_enabled_executor' };
        }
        const missing = agentReadiness.getState().find(agent => agent.required && agent.status !== 'installed');
        if (missing) return { allowed: false, reason: 'required_agent_unavailable', agentId: missing.agentId };
        return { allowed: true };
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
  const shutdownForSignal = (signal: NodeJS.Signals): void => {
    // Audit before anything else: without this line a stop can never be traced
    // back to the caller (CLI stop, Desktop update/repair, external kill).
    console.error(
      `MetaWork shutdown requested: signal=${signal} pid=${process.pid} `
      + `ppid=${process.ppid} uid=${String(process.getuid?.())} argv=${process.argv.join(' ')}`,
    );
    // Bounds drain + native exit; see exit-watchdog for why Node cannot do this itself.
    armExitWatchdog();
    void shutdown().then(
      () => process.exit(0),
      error => {
        console.error(`MetaWork shutdown failed: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => {
    shutdownForSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdownForSignal('SIGTERM');
  });

  // Windows 的 SIGTERM 是 TerminateProcess 硬杀；本地停服 CLI 写入带锁令牌的
  // 停机标记，Server 命中令牌即走与信号一致的内部优雅停机。
  if (instanceLock) {
    const lock = instanceLock;
    const shutdownMarkerPath = resolve(paths.data, SERVER_SHUTDOWN_MARKER);
    const shutdownMarkerTimer = setInterval(() => {
      void consumeShutdownMarker(shutdownMarkerPath, lock.token, () => shutdownForSignal('SIGTERM'));
    }, 500);
    shutdownMarkerTimer.unref?.();
  }

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
          && task && !isTerminalTaskStatus(task.status)
          && revision?.generationId === request.request.generationId
          && request.request.fingerprint === job.fact.version
          && Date.parse(request.createdAt) + 24 * 60 * 60 * 1000 > Date.now()
          && !new SqlitePermissionRepository(db).findResolution(job.fact.subjectId));
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
      publicTaskDelivery: async taskId => {
        const task = taskRepo.findById(taskId);
        if (!task || task.accountId !== LOCAL_DEFAULT_ACCOUNT_ID) return null;
        const publications = new WorkspacePublicationRepo(db);
        const graph = new WorkGraphRevisionRepo(db).findActive(taskId);
        return projectPublicDelivery({ task, workspace: await resolveTaskWorkspacePath(taskId),
          artifacts: [...taskArtifactRepo.publicFiles.list(LOCAL_DEFAULT_ACCOUNT_ID, taskId),
            ...taskArtifactRepo.listByTask(taskId).filter(item => item.accountId === LOCAL_DEFAULT_ACCOUNT_ID)], publications: publications.listByTask(taskId).filter(item => item.generationId === graph?.generationId
            && new SubtaskRepo(db).findById(item.subtaskId)?.graphRevision === graph?.revision),
          delivery: id => publications.delivery(id) });
      },
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
        .filter(record => record.status === 'published')
        .map(record => ({
          displayName: record.displayName,
          publishedPath: record.publishedPath,
          mediaType: record.mediaType,
          previewKind: record.previewKind,
        })),
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
      workspaceRoot,
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
        artifactVersionRepo: new ArtifactVersionRepo(db),
        objectRoot: join(accountPaths.workspaceStore, 'objects', 'sha256', 'artifacts'),
        resolveWorkspaceRoot: async workspaceId => (
          (await workspaceCatalogStore.findById(workspaceId))?.canonicalPath ?? null
        ),
      }),
      webAuth,
      desktopSessions,
      clientNotifications: { read: cursor => clientNotifications.read(LOCAL_DEFAULT_ACCOUNT_ID, cursor) },
      serviceActivity: () => activityProjection.serviceSummary(LOCAL_DEFAULT_ACCOUNT_ID),
      agentReadiness,
      tokenUsageQuery: createTokenUsageManagementQuery({ accountId: LOCAL_DEFAULT_ACCOUNT_ID, usage: meteringServices.tokenUsage, quotaContext }),
      memoryQuery: createMemoryManagementQuery({
        resolveRuntime: () => memoryRuntimeController.runtime,
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        readConfiguration: async () => {
          const snapshot = await configurationRepository.getActiveSnapshot();
          return { providers: snapshot.config.providers, models: snapshot.config.models };
        },
      }),
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
        projectExecutionTimelines: taskIds => executionProjector.projectMany(
          taskRepo.findTimelineByIds(LOCAL_DEFAULT_ACCOUNT_ID, taskIds),
        ),
        resolveTaskIdsForTurns: turnIds => meteringServices.contexts.taskIdsForTurns(LOCAL_DEFAULT_ACCOUNT_ID, turnIds),
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
          const queryContext = meteringServices.contexts.findByTurnId(
            LOCAL_DEFAULT_ACCOUNT_ID,
            turnId,
          );
          return queryContext
            ? meteringServices.contexts.findTaskLink(queryContext.queryId)?.taskId ?? null
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
          const revisionRepo = new WorkGraphRevisionRepo(db);
          const revision = revisionRepo.findActive(taskId) ?? revisionRepo.findLatest(taskId);
          if (!revision) return null;
          const subtasks = new SubtaskRepo(db).listByTask(taskId)
            .filter(subtask => subtask.generationId === revision.generationId);
          if (!subtasks.length) return null;
          const dispatchItems = new ControlDispatchItemRepo(db).listByTask(taskId);
          const receipts = new ExecutorAttemptReceiptRepo(db).listByTask(taskId);
          const publications = new WorkspacePublicationRepo(db).listByTask(taskId);
          const firstDispatchOrder = new Map<string, number>();
          for (const item of dispatchItems) {
            const current = firstDispatchOrder.get(item.subtaskId);
            if (current === undefined || item.batchOrder < current) {
              firstDispatchOrder.set(item.subtaskId, item.batchOrder);
            }
          }
          // The authorized graph is the owner fact; the decision ledger is gone.
          const graph: WorkGraphProposal = {
            schemaVersion: 7,
            configurationRevision: revision.configurationRevision,
            reason: revision.proposalSource,
            subtasks: subtasks.map(subtask => ({
              id: subtask.id,
              title: subtask.title,
              goal: subtask.goal,
              dependencies: subtask.dependencies,
              contextRefs: subtask.contextRefs,
              requiredCapabilities: subtask.requiredCapabilities as unknown as WorkGraphSubtask['requiredCapabilities'],

              deliveryKind: subtask.deliveryKind,
              acceptance: subtask.acceptance,
              riskLevel: subtask.riskLevel,
              ...(subtask.workspaceEffect ? { workspaceEffect: subtask.workspaceEffect } : {}),
              ...(subtask.fileOutputs ? { fileOutputs: subtask.fileOutputs } : {}),
            })),
          };
          const planDecisionFacts = subtasks.map(subtask => ({
            taskId,
            subtaskId: subtask.id,
            action: 'authorize_task_plan',
            authorizedBindings: subtask.executorBindings,
          }));
          const waits = new SqliteResourceLeaseRepository(db).findWaiting(taskId);
          return workGraphPresentationProjector.project({
            taskId,
            graphRevision: revision.revision,
            configuration: runtimeBindings.getRuntimeConfiguration(graph.configurationRevision)
              ?? runtimeBindings.getActiveRuntimeConfiguration(),
            graph,
            subtasks: subtasks.map(subtask => ({
              id: subtask.id,
              status: subtask.status,
              generationId: subtask.generationId,
              firstDispatchOrder: firstDispatchOrder.get(subtask.id) ?? null,
              resourceWaitAccess: waits.find(wait => wait.subtaskId === subtask.id && wait.generationId === subtask.generationId)?.access,
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
        fetchManualModelInformation,
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
        describeAgentCapabilities: async (input, refresh) => {
          const result = await agentCapabilityDescriptions.describe(input, refresh);
          return { ...result.description, ...(result.degraded ? { degraded: result.degraded } : {}) };
        },
        summarizeModelInformation: async (catalogModelId, preferredModel) => {
          const catalog = await openRouterModelCatalog.getSnapshot();
          const model = catalog.models[catalogModelId];
          if (!model) throw new Error('OpenRouter 未找到所选模型，请重新获取模型信息。');
          let degraded: DegradationNotice | undefined;
          const routingNotes = await modelRoutingProfiles.summarize(
            model,
            preferredModel,
            notice => { degraded = notice; },
          );
          return { catalogModelId, routingNotes, ...(degraded ? { degraded } : {}) };
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
          let protocol = input.protocol;
          let apiKey = input.apiKey?.trim() ?? '';
          // 明文密钥来自调用方（用户在设置页刚填的），不是从已激活配置读出的。
          // 这决定了下方的暂存语义：只有本次带明文密钥时才写入待激活暂存区。
          const suppliedApiKey = apiKey;
          if (!apiKey && input.providerRef) {
            try {
              const snapshot = await configurationService.getActiveSnapshot();
              const provider = snapshot.config.providers[input.providerRef];
              if (provider) {
                protocol ??= provider.protocol;
                assertSecretReference(provider.apiKeyRef);
                apiKey = (await secretStore.get(provider.apiKeyRef)).trim();
              }
            } catch {
              apiKey = '';
            }
          }
          // 待激活暂存在发现成功之后进行（见下方）：只有"连接测试通过"的密钥
          // 才算可用，才允许进入暂存区。
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

                  ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),

                }]] : [];
              })),
            prices: Object.fromEntries(modelIds.flatMap(modelId => {
                const model = openRouterCatalog.models[modelId];
                return model ? [[modelId, {

                }]] : [];
              })),
            };
          }
          if (!apiKey) return { status: 'unavailable' as const, modelIds: [], capabilities: {} };
          const discovery = await discoverOpenAiCompatibleModels({ baseUrl, apiKey, protocol });
          // 待激活暂存：用户填好 Provider 但还没保存激活时，先把端点与密钥落到
          // 本机，让"获取模型能力"这类需要调用模型的辅助功能在等待激活期间可用。
          //
          // 两条硬约束：
          // 1. 密钥走**独立的 pending 命名空间**，绝不写已激活 Provider 的引用
          //    ——否则用户编辑 Provider 时填的无效密钥会覆盖正在生效的密钥，
          //    把原本可用的模型弄坏。
          // 2. 只在连接测试**成功之后**暂存——测试通过即证明该密钥可用，
          //    无效密钥不会进入暂存区。
          if (discovery.status === 'discovered' && suppliedApiKey && input.providerRef && protocol) {
            const pendingApiKeyRef = `file-secret:anyfusion/pending/${input.providerRef}` as const;
            await secretStore.put(pendingApiKeyRef, suppliedApiKey).catch(() => undefined);
            await pendingProviderStore.remember({
              providerRef: input.providerRef,
              baseUrl,
              protocol,
              apiKeyRef: pendingApiKeyRef,
              savedAt: new Date().toISOString(),
            }).catch((error: unknown) => {
              console.warn(`[config] pending provider staging failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
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

                ...(model.publicFacts ? { publicFacts: model.publicFacts } : {}),

              }]] : [];
            })),
            prices: Object.fromEntries(modelIds.flatMap(modelId => {
              const model = openRouterCatalog.models[modelId];
              return model ? [[modelId, {

              }]] : [];
            })),
          };
        },
        activate: async (baseRevisionId, nextConfig, secrets, spanApiKey) => {
          const previousConfiguration = configurationRuntimeCoordinator.getSnapshot().config;
          const result = await configurationRuntimeCoordinator.activate({
            expectedRevisionId: baseRevisionId,
            config: nextConfig,
            secrets,
            ...(spanApiKey !== undefined ? { spanApiKey } : {}),
          });
          if (result.ok) {
            // The activation committed, so credentials of Providers this
            // revision removed are no longer reachable from any active path.
            try {
              await cleanupProviderCredentials({
                secretStore,
                previous: previousConfiguration,
                next: result.snapshot.config,
                logger: message => console.warn(`[config] ${message}`),
              });
            } catch (error) {
              console.warn(`[config] credential cleanup failed: ${(error as Error).message}`);
            }
            // Provider 已进入已激活配置：待激活暂存事实转正，不再保留两份。
            // pending 命名空间里的密钥同时清除——正式引用已由 stageSecrets 写入。
            try {
              const activatedRefs = Object.keys(result.snapshot.config.providers);
              await pendingProviderStore.forget(activatedRefs);
              for (const providerRef of activatedRefs) {
                await secretStore.delete(`file-secret:anyfusion/pending/${providerRef}`).catch(() => undefined);
              }
            } catch (error) {
              console.warn(`[config] pending provider cleanup failed: ${(error as Error).message}`);
            }
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
          let protocol: import('../configuration/types.js').ProviderProtocol | undefined;
          try {
            const active = await configurationService.getActiveSnapshot();
            const provider = active.config.providers[providerRef];
            protocol = provider?.protocol;
            if (!baseUrl) baseUrl = provider?.baseUrl ?? '';
          } catch {
            baseUrl = '';
          }
          if (!baseUrl) return { configured: true, valid: null, detail: 'provider baseUrl unknown' };
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8_000);
            const request = providerModelListRequest(baseUrl, apiKey, protocol);
            const response = await fetch(request.url, {
              headers: request.headers,
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
      officialAuthorization,
      sandboxSessionExchange: et => officialServiceClient.exchangeSandboxSession(et),
    });
    const webOrigin = managementServer?.address ?? 'http://127.0.0.1:8788';
    const composition = createServerComposition({
      startListeners: async () => ({ unixSocketPath: gatewaySocketPath, webOrigin }),
      stopListeners: async () => {
        const officialLogout = officialAuthorization.dispose();
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
          Promise.resolve(),
        ]);
        await officialLogout;
      },
      drain: async () => {
        clearInterval(taskPoolReviewTimer);
        clearInterval(activityProjectionTimer);
        if (notificationTimer) clearInterval(notificationTimer);
        await notificationDrain;
        clearInterval(directoryProjectionTimer);
        clearInterval(turnContentTimer);
        await directoryRebuild;
        await directoryDrain;
        await clientGateway.drain();
        await conversationGatewayRuntime.drain();
        await conversationRegistry.closeAll();
        await eventJournalRuntime.stop();
      },
      stopRuntime: async () => {
        await stopServerRuntimes({
          // No Planner child runtime exists: planning runs inside the Manager
          // turn, which is closed by the account registry shutdown below.
          stopPlanner: async () => undefined,
          shutdownAccounts: () => accountRegistry.shutdown(),
          // Final deposition before the Server stops (design §5.2).
          stopMemory: () => memoryRuntimeController.stop(),
        });
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
    desktopReady = true;
    console.log(`MetaWork Server ready: ${gatewaySocketPath}`);
    await new Promise(() => undefined);
    return;
}

}

/**
 * Resolve the Planner schema from the running build before trusting a stale
 * install pointer. Source-tree Server runs may intentionally reuse an
 * install root for data and credentials, while the active code and generated
 * schema live in the repository's dist directory.
 */
function resolvePlannerSchemaPath(applicationRoot: string): string {
  const configured = process.env.METACLAW_PLANNER_SCHEMA_PATH?.trim()
    || process.env.ANYFUSION_PLANNER_SCHEMA_PATH?.trim();
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), 'planning-agent-plan-v9.schema.json');
  const sourceBuild = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'planning-agent-plan-v9.schema.json');
  const candidates = [
    configured,
    resolve(applicationRoot, 'dist', 'planning-agent-plan-v9.schema.json'),
    bundled,
    sourceBuild,
  ].filter((value): value is string => Boolean(value));
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * The Manager extension needs the same canonical Plan contract the validator
 * uses; reuse the Planner schema resolver so both point at one file.
 */
function resolvePlanSchemaPath(applicationRoot: string): string {
  return resolvePlannerSchemaPath(applicationRoot);
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : { value };
}

function maskApiKey(value: string): string {
  return `••••••••${value.slice(-4)}`;
}

/** Message plus stack; a stack-less log made the 2026-10 null dereference unreachable. */
function errorStack(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ?? `${error.name}: ${error.message}`;
    return stack.replace(/[\r\n]+/g, ' | ').slice(0, 4_000);
  }
  return String(error).replace(/[\r\n]+/g, ' | ').slice(0, 4_000);
}
