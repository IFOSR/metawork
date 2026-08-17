// CLI entrypoint that assembles storage, runtime modules, gateway processes, and the default AnyFusion Planner TUI.
import { dirname, resolve } from 'path';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createDatabase } from './storage/database.js';
import { TaskRepo } from './storage/task-repo.js';
import { PreferenceRepo } from './storage/preference-repo.js';
import { TaskSearchIndexRepo } from './storage/task-search-index-repo.js';
import { TaskEngine } from './task/task-engine.js';
import { MemoryEngine } from './memory/memory-engine.js';
import { OrchestrationEngine } from './guidance/orchestration.js';
import { ContextRecaller } from './memory/context-recaller.js';
import { loadConfig } from './utils/config.js';
import { resolveMetaclawDir } from './utils/paths.js';
import { renderApp } from './tui/app.js';
import { formatCliHelp, parseCliArgs } from './cli/args.js';
import { parseAdminArgs } from './cli/admin-args.js';
import { runConfigurationAdmin, type ConfigurationMutationResult } from './commands/configuration-admin.js';
import { FileConfigurationRepository } from './configuration/file-configuration-repository.js';
import { FileSecretStore } from './configuration/file-secret-store.js';
import { AgentRuntimeRenderer } from './configuration/agent-runtime-renderer.js';
import { ConfigurationService, type ActivateDraftResult } from './configuration/configuration-service.js';
import type { AnyFusionConfigurationV2, ConfigurationSnapshot } from './configuration/types.js';
import { resolveAnyFusionPaths } from './installation/paths.js';
import { runScriptedSessionFile } from './session/scripted-session.js';
import { createNotificationService } from './notifications/feishu.js';
import { nanoid } from 'nanoid';
import { MetaclawGatewayServer } from './gateway/server.js';
import { runGatewayClientUi } from './gateway/client-ui.js';
import { resolveGatewaySocketPath } from './gateway/gateway-paths.js';
import { MarkdownPreviewServer } from './integrations/markdown-preview.js';
import { runGatewaySetup } from './gateway/setup.js';
import { startFeishuRuntimeBridge } from './gateway/feishu-runtime.js';
import { runGatewayPairingCommand } from './gateway/pairing-cli.js';
import { formatGatewayDoctorChecks, runGatewayDoctor } from './gateway/doctor.js';
import { MetaclawSession } from './session/metaclaw-session.js';
import { PlannerHostBridge } from './tui-bridge/planner-host-bridge.js';
import { PlannerProcessSupervisor } from './planning/planner-process-supervisor.js';
import { buildStagedLegacyConfiguration } from './configuration/staged-legacy-configuration.js';
import { LegacyConfigurationReader } from './configuration/legacy-configuration-reader.js';
import { ConfigurationMigrationService } from './configuration/configuration-migration-service.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from './core/authorized-executor-binding.js';
import { createSchema30MigrationContext } from './storage/migrations.js';
import { SubtaskRepo } from './storage/subtask-repo.js';
import { ExecutorAttemptReceiptRepo } from './storage/executor-attempt-receipt-repo.js';
import { KernelDecisionRepo } from './storage/kernel-decision-repo.js';
import { WorkspacePublicationRepo } from './storage/workspace-publication-repo.js';
import { ExecutorAttemptRuntimeRepo } from './storage/executor-attempt-runtime-repo.js';
import { KernelDispatchItemRepo } from './storage/kernel-dispatch-item-repo.js';
import {
  acquireInstanceLock,
  stopInstanceForRestart,
  type InstanceLock,
} from './management/lock.js';
import { buildWebStartupPresentation } from './management/token.js';
import { ManagementServer, type ConfigQuery, type ExecutionQuery } from './management/server.js';
import { ExecutionProjector } from './management/execution-projector.js';
import { createLocalExecutorConfigurationProbe } from './executor/configuration-probe.js';
import { WebAuthService } from './management/web-auth.js';
import { requiresCompositionLock } from './installation/composition-runtime.js';
import { FileWebSessionStore } from './storage/file-web-session-store.js';
import { WebSessionCatalog } from './management/web-session-catalog.js';
import { WebSessionRuntime } from './management/web-session-runtime.js';

function toMutationResult(result: ActivateDraftResult): ConfigurationMutationResult {
  if (result.ok) return { ok: true, revisionId: result.snapshot.revisionId };
  return { ok: false, code: result.code, activeRevisionId: result.activeRevisionId };
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
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

async function importAndActivateLegacyConfiguration(
  repository: FileConfigurationRepository,
  secretStore: FileSecretStore,
  renderer: AgentRuntimeRenderer,
): Promise<ConfigurationSnapshot> {
  const reader = new LegacyConfigurationReader({
    roots: [resolve(process.env.HOME ?? '.', '.config', 'anyfusion')],
  });
  const migrationService = new ConfigurationMigrationService(reader, repository, secretStore);
  const report = await migrationService.dryRun();
  const blocking = report.conflicts.filter(conflict => conflict.severity === 'error');
  if (blocking.length > 0) {
    throw new Error(
      `legacy configuration import blocked: ${blocking.map(conflict => conflict.message).join('; ')}`,
    );
  }
  const staged = await migrationService.stageCandidate(report);
  await repository.activateRevision(staged.revisionId, null);
  const snapshot = await repository.getActiveSnapshot();
  await renderer.render(snapshot);
  return snapshot;
}

async function runWebMode(options: {
  port: number;
  noOpen: boolean;
  runningRevisionId: string;
  sessionFactory: (sessionId: string) => MetaclawSession;
  executionQuery: ExecutionQuery;
  configQuery: ConfigQuery;
}): Promise<void> {
  const webAuth = new WebAuthService();
  const webDistDir = process.env.ANYFUSION_WEB_DIST
    ? resolve(process.env.ANYFUSION_WEB_DIST)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  const sessionRuntime = new WebSessionRuntime({
    catalog: new WebSessionCatalog(new FileWebSessionStore()),
    sessionFactory: options.sessionFactory,
    executionQuery: options.executionQuery,
  });
  const managementServer = new ManagementServer({
    port: options.port,
    webDistDir,
    token: webAuth.manualAccessToken,
    webAuth,
    runningRevisionId: options.runningRevisionId,
    sessionFactory: options.sessionFactory,
    sessionRuntime,
    executionQuery: options.executionQuery,
    configQuery: options.configQuery,
  });
  await managementServer.start();
  const presentation = buildWebStartupPresentation(
    managementServer.address,
    webAuth.bootstrapToken,
    webAuth.manualAccessToken,
    options.noOpen,
  );
  process.stdout.write(`${presentation.terminalLines.join('\n')}\n`);
  if (!options.noOpen) {
    openBrowser(presentation.browserUrl);
  }
  // 永久等待；进程由 SIGINT/SIGTERM 或外部终止。
  await new Promise<never>(() => {});
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (cliArgs.help) {
    process.stdout.write(`${formatCliHelp()}\n`);
    return;
  }

  if (cliArgs.webCommand === 'restart') {
    const dataDir = resolveAnyFusionPaths().data;
    mkdirSync(dataDir, { recursive: true });
    const result = await stopInstanceForRestart(resolve(dataDir, 'runtime.lock'));
    const message = result.status === 'stopped'
      ? `AnyFusion Web 旧实例已停止（PID ${result.pid}），正在重新启动。`
      : '未检测到运行中的 AnyFusion 实例，正在启动 Web。';
    process.stdout.write(`${message}\n`);
  }

  // 1. 初始化目录
  const metaclawDir = resolveMetaclawDir();
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  const gatewaySocketPath = resolveGatewaySocketPath(metaclawDir);
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  if (cliArgs.connect) {
    await runGatewayClientUi(gatewaySocketPath);
    return;
  }

  if (cliArgs.gatewayCommand === 'setup') {
    await runGatewaySetup({ metaclawDir });
    return;
  }

  if (cliArgs.gatewayCommand === 'pairing') {
    runGatewayPairingCommand({
      metaclawDir,
      command: cliArgs.gatewayPairingCommand ?? 'list',
      userId: cliArgs.gatewayPairingUserId,
    });
    return;
  }

  if (cliArgs.gatewayCommand === 'doctor') {
    const configPath = resolve(metaclawDir, 'config.yaml');
    const config = loadConfig(configPath);
    console.log(formatGatewayDoctorChecks(runGatewayDoctor({ config, metaclawDir })));
    return;
  }

  if (
    cliArgs.gatewayCommand === 'install'
    || cliArgs.gatewayCommand === 'start'
    || cliArgs.gatewayCommand === 'stop'
    || cliArgs.gatewayCommand === 'restart'
    || cliArgs.gatewayCommand === 'status'
  ) {
    console.log(`请使用 ./metaclaw.sh ${cliArgs.gatewayCommand} 管理后台进程。`);
    return;
  }

  const adminCommand = parseAdminArgs(process.argv.slice(2));
  if (adminCommand) {
    const configurationRepository = new FileConfigurationRepository(
      dirname(resolveAnyFusionPaths().configurationRevisions),
    );
    await configurationRepository.initialize();
    await configurationRepository.recover();
    const configurationService = new ConfigurationService({
      repository: configurationRepository,
      probe: createLocalExecutorConfigurationProbe(),
    });
    const activeSnapshot = await configurationService.getActiveSnapshot();
    const lines = await runConfigurationAdmin(adminCommand, {
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

  // Every mode that reaches Session/Kernel/Planner Host composition owns the
  // same runtime lock, including scripted sessions.
  let instanceLock: InstanceLock | null = null;
  let instanceLockPath: string | null = null;
  if (requiresCompositionLock(cliArgs)) {
    const dataDir = resolveAnyFusionPaths().data;
    mkdirSync(dataDir, { recursive: true });
    instanceLockPath = resolve(dataDir, 'runtime.lock');
    instanceLock = await acquireInstanceLock(instanceLockPath);
    process.once('exit', () => {
      if (instanceLockPath) unlinkSync(instanceLockPath);
    });
  }

  // 2. 加载配置
  const configPath = resolve(metaclawDir, 'config.yaml');
  const config = loadConfig(configPath);
  const markdownPreviewConfig = config.integrations?.markdown_preview;
  const markdownPreviewServer = markdownPreviewConfig?.enabled
    ? new MarkdownPreviewServer(markdownPreviewConfig, process.cwd())
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

  // 3. Seal the one staged configuration before storage migration and Session composition.
  const configurationRepository = new FileConfigurationRepository(
    dirname(resolveAnyFusionPaths().configurationRevisions),
  );
  await configurationRepository.initialize();
  const secretStore = new FileSecretStore(resolveAnyFusionPaths().secrets);
  await secretStore.initialize();
  await secretStore.assertSecurePermissions();
  const recovery = await configurationRepository.recover();
  const renderer = new AgentRuntimeRenderer(resolveAnyFusionPaths().generatedAgentRuntime);
  const migratedSnapshot = recovery.status === 'empty'
    ? await importAndActivateLegacyConfiguration(configurationRepository, secretStore, renderer)
    : await configurationRepository.getActiveSnapshot();
  const stagedConfiguration = buildStagedLegacyConfiguration({ migratedSnapshot });
  const configurationService = new ConfigurationService({
    repository: configurationRepository,
    secretStore,
    renderer,
    probe: createLocalExecutorConfigurationProbe(),
  });
  const resolveRuntimeBinding = (binding: AuthorizedExecutorBinding) =>
    configurationService.getRuntimeBinding(
      binding.configurationRevision,
      binding.agentClassRef,
      binding.modelRef,
    );
  const importedAt = new Date().toISOString();
  const plannerMigrationBinding = {
    ...stagedConfiguration.plannerBinding,
    bindingFingerprint: stagedConfiguration.plannerBindingFingerprint,
  };
  const legacyAgentClassBindings = {
    planner: {
      agentClassRef: plannerMigrationBinding.agentClassRef,
      harnessRef: plannerMigrationBinding.harnessRef,
      providerRef: plannerMigrationBinding.providerRef,
      modelRef: plannerMigrationBinding.modelRef,
      permissionProfileRef: plannerMigrationBinding.permissionProfileRef,
      bindingFingerprint: plannerMigrationBinding.bindingFingerprint,
    },
    ...Object.fromEntries(
      Object.entries(stagedConfiguration.snapshot.config.agentClasses)
        .filter(([, agentClass]) => agentClass.kind === 'executor')
        .map(([agentClassRef, agentClass]) => {
          if (agentClass.modelPolicy.mode !== 'fixed' || !agentClass.permissionProfileRef) {
            throw new Error(
              `staged legacy AgentClass requires fixed model and permission profile: ${agentClassRef}`,
            );
          }
          const model = stagedConfiguration.snapshot.config.models[
            agentClass.modelPolicy.modelRef
          ];
          if (!model) {
            throw new Error(
              `staged legacy AgentClass references missing Model: ${agentClassRef}`,
            );
          }
          const binding: AuthorizedExecutorBinding = {
            agentClassRef,
            harnessRef: agentClass.harnessRef,
            providerRef: model.providerRef,
            modelRef: agentClass.modelPolicy.modelRef,
            permissionProfileRef: agentClass.permissionProfileRef,
            configurationRevision: stagedConfiguration.snapshot.revisionId,
          };
          return [agentClassRef, {
            agentClassRef: binding.agentClassRef,
            harnessRef: binding.harnessRef,
            providerRef: binding.providerRef,
            modelRef: binding.modelRef,
            permissionProfileRef: binding.permissionProfileRef,
            bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
          }];
        }),
    ),
  };
  const migrationContext = createSchema30MigrationContext({
    revisionId: stagedConfiguration.snapshot.revisionId,
    contentHash: stagedConfiguration.snapshot.contentHash,
    importedAt,
    plannerBinding: plannerMigrationBinding,
    legacyAgentClassBindings,
  });
  const db = createDatabase(
    resolve(metaclawDir, 'metaclaw.db'),
    migrationContext,
  );

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
  const notifier = createNotificationService(config);
  const plannerHostSocketPath = (process.env.METACLAW_PLANNER_HOST_SOCKET
    ?? process.env.METACLAW_PLANNER_TUI_SOCKET
    ?? resolve(metaclawDir, 'anyfusion-planner.sock')).trim();
  process.env.METACLAW_PLANNER_HOST_SOCKET = plannerHostSocketPath;
  process.env.METACLAW_PLANNER_TUI_SOCKET = plannerHostSocketPath;
  const plannerHost = new PlannerHostBridge({ socketPath: plannerHostSocketPath, logger: console });
  const plannerSupervisor = new PlannerProcessSupervisor({
    socketPath: plannerHostSocketPath,
    configurationRevision: stagedConfiguration.snapshot.revisionId,
  });
  await plannerHost.start();

  if (cliArgs.scriptPath) {
    try {
      const result = await runScriptedSessionFile(cliArgs.scriptPath, {
        taskEngine,
        memoryEngine,
        orchestration,
        db,
        config,
        sessionId,
        contextRecaller,
        notifier,
        plannerHost,
        plannerSupervisor,
        stagedConfiguration,
        getRuntimeBinding: resolveRuntimeBinding,
      });
      if (result.output.length > 0) {
        process.stdout.write(`${result.output.join('\n')}\n`);
      }
    } finally {
      await Promise.all([
        plannerHost.stop(),
        plannerSupervisor.stop(),
      ]);
    }
    return;
  }

  if (cliArgs.web) {
    const executionProjector = new ExecutionProjector({
      subtaskRepo: new SubtaskRepo(db),
      receiptRepo: new ExecutorAttemptReceiptRepo(db),
      decisionRepo: new KernelDecisionRepo(db),
      publicationRepo: new WorkspacePublicationRepo(db),
      attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db),
      dispatchItemRepo: new KernelDispatchItemRepo(db),
    });
    await runWebMode({
      port: cliArgs.webPort ?? 8788,
      noOpen: cliArgs.webNoOpen === true,
      runningRevisionId: stagedConfiguration.snapshot.revisionId,
      sessionFactory: webSessionId => new MetaclawSession({
        taskEngine,
        memoryEngine,
        orchestration,
        db,
        config,
        sessionId: webSessionId,
        contextRecaller,
        notifier,
        plannerHost,
        plannerSupervisor,
        stagedConfiguration,
        getRuntimeBinding: resolveRuntimeBinding,
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
        activate: async (baseRevisionId, nextConfig) =>
          activateConfiguration(
            configurationService,
            nextConfig as AnyFusionConfigurationV2,
            baseRevisionId,
          ),
        rollback: async targetRevisionId => {
          const active = await configurationService.getActiveSnapshot();
          return toMutationResult(await configurationService.rollback(targetRevisionId, active.revisionId));
        },
        writeSecret: async (providerRef, apiKey) => {
          const reference = `file-secret:anyfusion/providers/${providerRef}` as const;
          await secretStore.put(reference, apiKey);
          return { apiKeyRef: reference };
        },
      },
    });
    return;
  }

  const plannerTuiCommand = process.env.METACLAW_PLANNER_TUI_COMMAND?.trim() ?? 'anyfusion-planner';
  process.env.METACLAW_PLANNER_TUI_COMMAND = plannerTuiCommand;
  if (process.env.METACLAW_STANDBY_TUI !== '1') {
    const plannerTuiSession = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      sessionId,
      contextRecaller,
      notifier,
      plannerHost,
      plannerSupervisor,
      stagedConfiguration,
      getRuntimeBinding: resolveRuntimeBinding,
    });
    plannerTuiSession.initialize({ showDashboard: false });
    const nativeGatewayServer = new MetaclawGatewayServer({
      socketPath: gatewaySocketPath,
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      contextRecaller,
      notifier,
      workspaceRoot: process.cwd(),
      plannerHost,
      plannerSupervisor,
      stagedConfiguration,
      getRuntimeBinding: resolveRuntimeBinding,
    });
    await nativeGatewayServer.start();
    const blockedRecheckTimer = setInterval(() => {
      void plannerTuiSession.maybeReviewTaskPoolOnTimer().catch(error => {
        plannerTuiSession.appendSystemMessage(`错误: ${(error as Error).message}`);
      });
    }, plannerTuiSession.getBlockedRecheckIntervalMs());
    try {
      await plannerSupervisor.startInteractive({
        sessionId,
        cwd: process.cwd(),
      });
    } finally {
      clearInterval(blockedRecheckTimer);
      await plannerTuiSession.dispose();
      await Promise.all([
        plannerHost.stop(),
        plannerSupervisor.stop(),
        nativeGatewayServer.stop(),
        markdownPreviewServer?.stop() ?? Promise.resolve(),
      ]);
    }
    return;
  }

  const gatewayServer = new MetaclawGatewayServer({
    socketPath: gatewaySocketPath,
    taskEngine,
    memoryEngine,
    orchestration,
    db,
    config,
    contextRecaller,
    notifier,
    workspaceRoot: process.cwd(),
    plannerHost,
    plannerSupervisor,
    stagedConfiguration,
    getRuntimeBinding: resolveRuntimeBinding,
  });

  await gatewayServer.start();
  let gatewayFeishuBridge: Awaited<ReturnType<typeof startFeishuRuntimeBridge>> = null;
  let gatewayBlockedRecheckTimer: NodeJS.Timeout | null = null;
  let gatewaySession: MetaclawSession | null = null;
  if (cliArgs.gateway) {
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      sessionId,
      contextRecaller,
      notifier,
      plannerHost,
      plannerSupervisor,
      stagedConfiguration,
      getRuntimeBinding: resolveRuntimeBinding,
    });
    gatewaySession = session;
    session.initialize({ showDashboard: false });
    gatewayFeishuBridge = await startFeishuRuntimeBridge(config, session);
    gatewayBlockedRecheckTimer = setInterval(() => {
      void session.maybeReviewTaskPoolOnTimer().catch(error => {
        session.appendSystemMessage(`错误: ${(error as Error).message}`);
      });
    }, session.getBlockedRecheckIntervalMs());
  }
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (gatewayBlockedRecheckTimer) {
        clearInterval(gatewayBlockedRecheckTimer);
        gatewayBlockedRecheckTimer = null;
      }
      try {
        await Promise.all([
          gatewayFeishuBridge?.stop() ?? Promise.resolve(),
          gatewayServer.stop(),
          plannerHost.stop(),
          plannerSupervisor.stop(),
          markdownPreviewServer?.stop() ?? Promise.resolve(),
        ]);
      } finally {
        await gatewaySession?.dispose();
        gatewaySession = null;
      }
    })();
    return shutdownPromise;
  };
  process.once('exit', () => {
    if (gatewayBlockedRecheckTimer) clearInterval(gatewayBlockedRecheckTimer);
    void gatewaySession?.dispose();
    void gatewayFeishuBridge?.stop();
    void markdownPreviewServer?.stop();
    void gatewayServer.stop();
    void plannerHost.stop();
    void plannerSupervisor.stop();
  });
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  if (cliArgs.gateway) {
    console.log(`Metaclaw Gateway listening: ${gatewaySocketPath}`);
    await new Promise(() => undefined);
    return;
  }

  // 9. 启动 TUI
  renderApp({
    taskEngine,
    memoryEngine,
    orchestration,
    db,
    config,
    sessionId,
    contextRecaller,
    notifier,
    plannerHost,
    plannerSupervisor,
    stagedConfiguration,
  });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
