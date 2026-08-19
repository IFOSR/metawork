import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { ConfigurationCompiler } from '../configuration/configuration-compiler.js';
import { createProductionConfigurationProbe } from '../configuration/production-configuration-probe.js';
import { ConfigurationService } from '../configuration/configuration-service.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import { assertSecretReference, type SecretStore } from '../configuration/secret-store.js';
import type { AnyFusionConfigurationV2 } from '../configuration/types.js';
import { runMigrations } from '../storage/migrations.js';
import type { AnyFusionPaths } from './paths.js';
import { resolveReleasePaths } from './paths.js';
import {
  assertLauncherAvailable,
  installNativeLauncher,
  removeManagedLauncher,
} from './native-launcher.js';

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SourceNativeInstallInput {
  releaseId: string;
  sourceRoot: string;
  plannerRoot: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    region: string;
    secretReference: string;
  };
}

export interface SourceNativeInstallResult {
  releaseId: string;
  configurationRevision: string;
}

export class SourceNativeInstaller {
  constructor(private readonly dependencies: {
    paths: AnyFusionPaths;
    secretStore: SecretStore;
    detectCommand(command: string): Promise<boolean>;
  }) {}

  async install(input: SourceNativeInstallInput): Promise<SourceNativeInstallResult> {
    assertReleaseId(input.releaseId);
    assertSecretReference(input.provider.secretReference);
    const secretReference = input.provider.secretReference;
    const paths = this.dependencies.paths;
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
    const release = resolveReleasePaths(paths.root, input.releaseId);
    const configurationRevision = `install-${input.releaseId}`;
    const databaseRevision = join(
      accountPaths.databaseRevisions,
      `${input.releaseId}-${configurationRevision}.db`,
    );
    const repository = new FileConfigurationRepository(accountPaths.config);
    const service = new ConfigurationService({
      repository,
      createRevisionId: () => configurationRevision,
      probe: createProductionConfigurationProbe({
        releaseRoot: release.releaseRoot,
        secretStore: this.dependencies.secretStore,
        detectCommand: this.dependencies.detectCommand,
      }),
    });

    await assertInstallTargetIsClean(
      paths,
      accountPaths,
      release.releaseRoot,
      configurationRevision,
    );
    await assertLauncherAvailable(paths.launcher);
    const [codexDetected, piDetected] = await Promise.all([
      this.dependencies.detectCommand('codex'),
      this.dependencies.detectCommand('pi'),
    ]);
    const config = buildConfiguration(input, codexDetected, piDetected);

    const switched: string[] = [];
    let launcherInstalled = false;
    let secretStored = false;
    let compiledRuntimeRoot: string | null = null;
    try {
      await stageSourceRelease(input.sourceRoot, input.plannerRoot, release.releaseRoot);
      await this.dependencies.secretStore.put(secretReference, input.provider.apiKey);
      secretStored = true;
      await service.initialize();
      const draft = service.createDraft(config, null);
      const validation = service.validateDraft(draft.revisionId);
      if (!validation.ok) {
        throw new Error(
          `generated installation configuration is invalid: ${validation.issues
            .map(issue => `${issue.path}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const compiledConfiguration = service.compileDraft(draft.revisionId);
      const probe = await service.probeDraft(draft.revisionId);
      if (!probe.ok) {
        throw new Error(`installation configuration probe failed: ${(probe.issues ?? []).join('; ')}`);
      }

      const compiler = new ConfigurationCompiler(accountPaths.generatedAgentRuntime);
      await mkdir(accountPaths.generatedAgentRuntime, { recursive: true, mode: 0o700 });
      const compiledRuntime = await compiler.compile({
        revisionId: configurationRevision,
        contentHash: compiledConfiguration.contentHash,
        config: validation.config,
      });
      compiledRuntimeRoot = compiledRuntime.rootPath;
      await createFreshDatabase(databaseRevision);

      await installNativeLauncher(paths.launcher, paths.root);
      launcherInstalled = true;
      await replaceRelativeSymlink(
        accountPaths.generatedCurrent,
        relative(dirname(accountPaths.generatedCurrent), compiledRuntime.rootPath),
      );
      switched.push(accountPaths.generatedCurrent);
      await replaceRelativeSymlink(
        accountPaths.database,
        relative(dirname(accountPaths.database), databaseRevision),
      );
      switched.push(accountPaths.database);
      await replaceRelativeSymlink(
        paths.appCurrent,
        relative(dirname(paths.appCurrent), release.releaseRoot),
      );
      switched.push(paths.appCurrent);
      const activated = await service.activateDraft(configurationRevision, null);
      if (!activated.ok) {
        throw new Error('configuration activation conflicted during clean installation');
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      await collectCleanupError(
        cleanupErrors,
        Promise.all(switched.map(path => rm(path, { force: true }))),
      );
      if (launcherInstalled) {
        await collectCleanupError(cleanupErrors, removeManagedLauncher(paths.launcher));
      }
      if (secretStored) {
        await collectCleanupError(
          cleanupErrors,
          this.dependencies.secretStore.delete(secretReference),
        );
      }
      for (const path of [
        compiledRuntimeRoot,
        databaseRevision,
        join(accountPaths.configRevisions, configurationRevision),
        release.releaseRoot,
      ]) {
        if (!path) continue;
        await collectCleanupError(cleanupErrors, removeImmutablePath(path));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'clean installation failed and staged-state cleanup was incomplete',
        );
      }
      throw error;
    }

    return { releaseId: input.releaseId, configurationRevision };
  }
}

async function collectCleanupError(
  errors: unknown[],
  cleanup: Promise<unknown>,
): Promise<void> {
  try {
    await cleanup;
  } catch (error) {
    errors.push(error);
  }
}

async function removeImmutablePath(path: string): Promise<void> {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

function buildConfiguration(
  input: SourceNativeInstallInput,
  codexEnabled: boolean,
  piEnabled: boolean,
): AnyFusionConfigurationV2 {
  const modelRef = 'default-model';
  return {
    schemaVersion: 2,
    providers: {
      provider: {
        protocol: 'openai-compatible',
        baseUrl: input.provider.baseUrl,
        apiKeyRef: input.provider.secretReference,
        region: input.provider.region,
        enabled: true,
      },
    },
    models: {
      [modelRef]: {
        providerRef: 'provider',
        modelId: input.provider.modelId,
        capabilities: ['coding', 'long-context', 'planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
    },
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'codex-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: codexEnabled,
      },
      'pi-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: piEnabled,
      },
    },
    agentClasses: {
      'planner-default': {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: ['metaclaw-planner'],
        mcpServers: ['metaclaw-planner'],
        plugins: [],
        generatedRuntimeRef: 'planner-default',
        enabled: true,
      },
      'codex-engineering': {
        kind: 'executor',
        harnessRef: 'codex-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation'],
        avoidUseCases: ['current public-web research requiring source-backed delivery'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'codex-engineering',
        enabled: codexEnabled,
      },
      'pi-research': {
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef },
        permissionProfileRef: 'public-web-research',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['current public-web research', 'source verification'],
        avoidUseCases: ['repository modification and engineering verification'],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-research',
        enabled: piEnabled,
      },
    },
    permissionProfiles: {
      'workspace-engineering': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: { maxAdditionalReadPartitions: 8 },
      },
      'public-web-research': {
        profileId: 'public-web-research',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  };
}

export async function stageSourceRelease(
  sourceRoot: string,
  plannerRoot: string,
  releaseRoot: string,
): Promise<void> {
  const stageRoot = `${releaseRoot}.stage-${randomUUID()}`;
  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  try {
    await Promise.all([
      cp(join(sourceRoot, 'dist'), join(stageRoot, 'dist'), { recursive: true }),
      cp(join(sourceRoot, 'node_modules'), join(stageRoot, 'node_modules'), { recursive: true }),
      copyFile(join(sourceRoot, 'package.json'), join(stageRoot, 'package.json')),
      cp(plannerRoot, join(stageRoot, 'planner'), {
        recursive: true,
        filter: source => basename(source) !== '.git',
      }),
    ]);
    await mkdir(dirname(releaseRoot), { recursive: true, mode: 0o700 });
    await rename(stageRoot, releaseRoot);
    await makeImmutable(releaseRoot);
  } catch (error) {
    await makeWritable(stageRoot);
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createFreshDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('fresh database integrity check failed');
    }
  } finally {
    db.close();
  }
  await chmod(path, 0o600);
}

async function replaceRelativeSymlink(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${randomUUID()}`;
  await symlink(target, temporary);
  await rename(temporary, path);
}

async function assertInstallTargetIsClean(
  paths: AnyFusionPaths,
  accountPaths: ReturnType<typeof resolveAccountPaths>,
  releaseRoot: string,
  configurationRevision: string,
): Promise<void> {
  for (const path of [
    paths.appCurrent,
    accountPaths.generatedCurrent,
    accountPaths.database,
    releaseRoot,
    join(accountPaths.configRevisions, configurationRevision),
  ]) {
    if (await lstat(path).then(() => true, () => false)) {
      throw new Error(`clean installation target already exists: ${path}`);
    }
  }
}

async function makeImmutable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    const { readdir } = await import('node:fs/promises');
    for (const child of await readdir(path)) {
      await makeImmutable(join(path, child));
    }
    await chmod(path, 0o555);
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o444);
  }
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    const { readdir } = await import('node:fs/promises');
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}

function assertReleaseId(releaseId: string): void {
  if (!RELEASE_ID.test(releaseId)) throw new Error(`invalid release ID: ${releaseId}`);
}
