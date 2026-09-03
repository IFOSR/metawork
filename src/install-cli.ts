import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandExistsOnPath } from './configuration/production-configuration-probe.js';
import { createProductionSecretStore } from './configuration/production-secret-store.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from './account/account-id.js';
import { resolveAccountPaths } from './account/account-paths.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import {
  PRODUCT_ENVIRONMENT,
  resolveProductEnvironment,
} from './installation/product-environment.js';
import { InstallerCore } from './installation/installer-core.js';
import { AccountLayoutMigrator } from './installation/account-layout-migrator.js';
import { SourceNativeInstaller } from './installation/source-native-installer.js';
import { SourceNativeUpdater } from './installation/source-native-updater.js';
import { FileConfigurationRepository } from './configuration/file-configuration-repository.js';
import {
  ProductRootMigrator,
  type ProductRootMigration,
} from './installation/product-root-migrator.js';
import { isInstanceRunning } from './management/lock.js';
import { ServerUpdateCoordinator } from './session/server-update-coordinator.js';
import {
  collectProviderInput,
  createTerminalProviderPrompt,
  type ProviderProbe,
  type WizardProviderDefaults,
  type WizardProviderInput,
} from './installation/configuration-wizard.js';

export type NativeInstallCommand = 'install' | 'update' | 'rollback';

export interface NativeInstallArgs {
  command: NativeInstallCommand;
  releaseId: string;
  sourceRoot?: string;
  plannerRoot?: string;
}

export function parseNativeInstallArgs(argv: string[]): NativeInstallArgs {
  const [command, releaseId, ...options] = argv;
  if (command !== 'install' && command !== 'update' && command !== 'rollback') {
    throw new Error('usage: metawork-install <install|update|rollback> <release-id>');
  }
  if (!releaseId?.trim()) throw new Error('release ID is required');
  const parsed: NativeInstallArgs = { command, releaseId };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if (option === '--source-root' || option === '--planner-root') {
      if (!value || value.startsWith('--')) {
        throw new Error(`${option} requires a value`);
      }
      if (option === '--source-root') parsed.sourceRoot = value;
      else parsed.plannerRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown installer option: ${option}`);
  }
  if (
    (command === 'install' || command === 'update')
    && (!parsed.sourceRoot || !parsed.plannerRoot)
  ) {
    throw new Error(`${command} requires --source-root and --planner-root`);
  }
  return parsed;
}

export async function runNativeInstallCli(
  argv: string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    detectCommand?: (command: string) => Promise<boolean>;
    isServerRunning?: () => Promise<boolean>;
    write?: (line: string) => void;
    isInteractive?: () => boolean;
    collectProviderConfiguration?: (
      defaults: WizardProviderDefaults,
    ) => Promise<WizardProviderInput>;
    probeProvider?: ProviderProbe;
  } = {},
): Promise<number> {
  const args = parseNativeInstallArgs(argv);
  const env = dependencies.env ?? process.env;
  const productEnvironment = resolveInstallerEnvironment(env);
  const rootMigration = await prepareProductRootMigration(
    args.command,
    env,
    productEnvironment.installRoot,
  );
  const paths = rootMigration?.paths
    ?? resolveMetaWorkPaths(env.HOME, productEnvironment.installRoot);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const activeSecretReferences = args.command === 'install'
    ? []
    : await readActiveSecretReferences(accountPaths.config);
  const secretStore = createProductionSecretStore({
    platform: dependencies.platform,
    secretsRoot: accountPaths.secrets,
    env,
    references: activeSecretReferences,
  });
  const detectCommand = dependencies.detectCommand
    ?? (command => commandExistsOnPath(command, env.PATH ?? ''));
  const isServerRunning = dependencies.isServerRunning
    ?? (() => isInstanceRunning(join(paths.data, 'runtime.lock')));
  const write = dependencies.write ?? (line => process.stdout.write(`${line}\n`));
  const isInteractive = dependencies.isInteractive
    ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const collectProviderConfiguration = dependencies.collectProviderConfiguration
    ?? (async defaults => {
      const prompt = createTerminalProviderPrompt({});
      try {
        return await collectProviderInput(prompt, {
          defaults,
          probe: dependencies.probeProvider ?? probeOpenAiCompatibleProvider,
        });
      } finally {
        prompt.close();
      }
    });

  if (args.command === 'install') {
    const secretScheme = productEnvironment.secretStore === 'file'
      ? 'file-secret'
      : 'keychain';
    const provider = await resolveInstallProvider(
      productEnvironment,
      { isInteractive, collectProviderConfiguration },
    );
    const result = await runOfflineNativeTransaction({
      command: args.command,
      releaseId: args.releaseId,
      paths,
      isServerRunning,
      operation: () => new SourceNativeInstaller({
        paths,
        secretStore,
        detectCommand,
      }).install({
        releaseId: args.releaseId,
        sourceRoot: args.sourceRoot!,
        plannerRoot: args.plannerRoot!,
        provider: {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: provider.modelId,
          region: provider.region,
          secretReference:
            `${secretScheme}:anyfusion/provider`,
        },
      }),
    });
    write(`installed ${result.releaseId} with configuration ${result.configurationRevision}`);
    write('next: export PATH="$HOME/.local/bin:$PATH" && metawork --help');
    return 0;
  }

  const updater = new SourceNativeUpdater({
    paths,
    secretStore,
    detectCommand,
    isServerRunning,
  });
  if (args.command === 'update') {
    try {
      const result = await runOfflineNativeTransaction({
        command: args.command,
        releaseId: args.releaseId,
        paths,
        isServerRunning,
        operation: () => updater.update({
          releaseId: args.releaseId,
          sourceRoot: args.sourceRoot!,
          plannerRoot: args.plannerRoot!,
        }),
      });
      await rootMigration?.commit();
      write(`updated to ${args.releaseId} (${result.upgradeId})`);
      return 0;
    } catch (error) {
      await rootMigration?.rollback();
      throw error;
    }
  }
  try {
    const result = await runOfflineNativeTransaction({
      command: args.command,
      releaseId: args.releaseId,
      paths,
      isServerRunning,
      operation: () => updater.rollback(args.releaseId),
    });
    await rootMigration?.commit();
    write(`rolled back to ${args.releaseId} (${result.upgradeId})`);
    return 0;
  } catch (error) {
    await rootMigration?.rollback();
    throw error;
  }
}

interface InstallerProviderBinding {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  region: string;
}

async function resolveInstallProvider(
  productEnvironment: ReturnType<typeof resolveInstallerEnvironment>,
  interaction: {
    isInteractive(): boolean;
    collectProviderConfiguration(defaults: WizardProviderDefaults): Promise<WizardProviderInput>;
  },
): Promise<InstallerProviderBinding> {
  let { providerKey: apiKey, providerUrl: baseUrl, providerModel: modelId } = productEnvironment;
  if (!apiKey || !baseUrl) {
    if (!interaction.isInteractive()) {
      throw new Error(
        'provider configuration is required: set METAWORK_PROVIDER_KEY and METAWORK_PROVIDER_URL'
        + ' for non-interactive installs, or run in a terminal to use the setup wizard',
      );
    }
    const collected = await interaction.collectProviderConfiguration({
      baseUrl,
      modelId,
    });
    apiKey = collected.apiKey;
    baseUrl = collected.baseUrl;
    modelId = collected.modelId;
  }
  return {
    baseUrl: requiredProductEnvironment(baseUrl, PRODUCT_ENVIRONMENT.providerUrl[0]),
    apiKey: requiredProductEnvironment(apiKey, PRODUCT_ENVIRONMENT.providerKey[0]),
    modelId: requiredProductEnvironment(modelId, PRODUCT_ENVIRONMENT.providerModel[0]),
    region: productEnvironment.providerRegion ?? 'international',
  };
}

async function probeOpenAiCompatibleProvider(baseUrl: string, apiKey: string): Promise<
  | { status: 'verified' }
  | { status: 'unverifiable'; detail?: string }
  | { status: 'rejected'; detail?: string }
> {
  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/models`;
  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'rejected', detail: `HTTP ${response.status} from GET /models` };
    }
    if (response.ok) return { status: 'verified' };
    return { status: 'unverifiable', detail: `HTTP ${response.status} from GET /models` };
  } catch (error) {
    return {
      status: 'unverifiable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readActiveSecretReferences(configRoot: string): Promise<string[]> {
  const repository = new FileConfigurationRepository(configRoot);
  await repository.initialize();
  const recovery = await repository.recover();
  if (recovery.status === 'empty') return [];
  const snapshot = await repository.getActiveSnapshot();
  return Object.values(snapshot.config.providers).map(provider => provider.apiKeyRef);
}

async function prepareProductRootMigration(
  command: NativeInstallCommand,
  env: NodeJS.ProcessEnv,
  installRoot: string | undefined,
): Promise<ProductRootMigration | null> {
  if (command === 'install' || installRoot !== undefined) return null;
  return new ProductRootMigrator({ userHome: env.HOME }).prepare();
}

async function runOfflineNativeTransaction<T>(input: {
  command: NativeInstallCommand;
  releaseId: string;
  paths: ReturnType<typeof resolveMetaWorkPaths>;
  isServerRunning(): Promise<boolean>;
  operation(): Promise<T>;
}): Promise<T> {
  const upgradeId = `${input.command}-${input.releaseId}-${randomUUID()}`;
  let value: T | undefined;
  let operationError: unknown;
  let runningServer = false;
  const installer = new InstallerCore({
    preflight: async () => undefined,
    // SourceNativeUpdater owns the host lock and its lower-level activation
    // journal; this outer core durably audits the production CLI orchestration.
    acquireUpdateLock: async () => true,
    closeTaskAdmission: async () => undefined,
    quiesceDispatch: async () => undefined,
    awaitIdle: async () => true,
    verifyManifest: async () => undefined,
    stageRelease: async () => undefined,
    backupDatabase: async () => undefined,
    migrateDatabase: async () => undefined,
    install: async () => {
      try {
        value = await input.operation();
        // ADR-0031: 安装/升级后把本地状态迁移进 local-default 账户根。
        const migrator = new AccountLayoutMigrator({ paths: input.paths });
        await migrator.migrate();
      } catch (error) {
        operationError = error;
        throw error;
      }
    },
    configure: async () => undefined,
    doctor: async () => undefined,
    activate: async () => undefined,
    startCandidate: async () => undefined,
    healthCheck: async () => undefined,
    reopenAdmission: async () => undefined,
    commitJournal: async () => undefined,
    // Source-native operations perform their own pointer rollback before
    // returning an error, so the outer lifecycle has no second mutation.
    rollback: async () => undefined,
    releaseUpdateLock: async () => undefined,
  }, {
    journalPath: join(input.paths.upgradeJournals, `${upgradeId}.json`),
  });
  const coordinator = new ServerUpdateCoordinator({
    acquireLease: async () => {
      runningServer = await input.isServerRunning();
      return { held: !runningServer, holder: upgradeId };
    },
    closeTaskAdmission: async () => undefined,
    quiesceDispatch: async () => undefined,
    awaitIdle: async () => true,
    stopSurfaces: async () => undefined,
    closeDatabase: async () => undefined,
    startCandidate: async () => {
      const result = await installer.install(input.releaseId, upgradeId, 0);
      if (result.outcome !== 'committed') {
        throw operationError ?? new Error(result.error ?? `installer ${result.outcome}`);
      }
    },
    restartPrevious: async () => undefined,
    openTaskAdmission: async () => undefined,
    releaseLease: async () => undefined,
  });

  const coordinated = await coordinator.runUpdate(0);
  if (coordinated.outcome !== 'committed') {
    if (operationError) throw operationError;
    if (runningServer) {
      throw new Error(
        'running Server cannot be safely coordinated by the offline installer; stop it before retrying',
      );
    }
    throw new Error(`native ${input.command} transaction ${coordinated.outcome}`);
  }
  if (value === undefined) {
    throw new Error(`native ${input.command} transaction returned no result`);
  }
  return value;
}

function resolveInstallerEnvironment(env: NodeJS.ProcessEnv): {
  installRoot: string | undefined;
  providerKey: string | undefined;
  providerUrl: string | undefined;
  providerModel: string | undefined;
  providerRegion: string | undefined;
  secretStore: string | undefined;
} {
  return {
    installRoot: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.installRoot),
    providerKey: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.providerKey),
    providerUrl: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.providerUrl),
    providerModel: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.providerModel),
    providerRegion: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.providerRegion),
    secretStore: resolveProductEnvironment(env, ...PRODUCT_ENVIRONMENT.secretStore),
  };
}

function requiredProductEnvironment(
  value: string | undefined,
  canonicalName: string,
): string {
  if (!value) throw new Error(`${canonicalName} is required`);
  return value;
}

if (
  process.argv[1]
  // realpathSync matters on macOS, where launch paths such as
  // /var/folders/... (TMPDIR) and /tmp resolve through /private symlink
  // chains that import.meta.url collapses but pathToFileURL keeps literal.
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  runNativeInstallCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(
      `MetaWork installer failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
