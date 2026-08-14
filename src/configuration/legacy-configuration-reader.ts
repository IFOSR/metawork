import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { parseAnyFusionConfigurationV2 } from './schema.js';
import type { AnyFusionConfigurationV2 } from './types.js';

const execFileAsync = promisify(execFile);

export interface LegacyConflict {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
  suggestedFix: string;
}

export interface LegacySourceHash {
  kind: string;
  path: string;
  sha256: string;
  byteSize: number;
}

export interface LegacySecretImportPlan {
  reference: string;
  sourcePath: string;
  sourceKey: string;
  valueSha256: string;
}

export interface LegacyRepositoryStatus {
  path: string;
  exists: boolean;
  dirty: boolean;
  head: string | null;
  statusHash: string | null;
}

export interface LegacyAgentClassRecord {
  id: string;
  kind: 'planner' | 'executor';
  modelRef: string;
  command?: string;
  permissionProfileId?: 'workspace-engineering' | 'public-web-research';
}

export interface LegacyConfigurationInventory {
  candidate: AnyFusionConfigurationV2;
  sourceHashes: LegacySourceHash[];
  secretImportPlan: LegacySecretImportPlan[];
  conflicts: LegacyConflict[];
  dirtyRepositories: LegacyRepositoryStatus[];
  redactedReport: {
    sources: LegacySourceHash[];
    conflicts: LegacyConflict[];
    repositories: LegacyRepositoryStatus[];
  };
}

export interface LegacyConfigurationReaderOptions {
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  legacyAgentClasses?: LegacyAgentClassRecord[];
  readAgentClasses?: () => Promise<LegacyAgentClassRecord[]>;
  inspectGit?: (path: string) => Promise<LegacyRepositoryStatus>;
}

interface ParsedSource {
  source: LegacySourceHash;
  value: unknown;
}

export class LegacyConfigurationReader {
  private readonly env: NodeJS.ProcessEnv;
  private readonly inspectGit: (path: string) => Promise<LegacyRepositoryStatus>;

  constructor(private readonly options: LegacyConfigurationReaderOptions = {}) {
    this.env = { ...options.env };
    this.inspectGit = options.inspectGit ?? inspectGit;
  }

  async read(): Promise<LegacyConfigurationInventory> {
    const conflicts: LegacyConflict[] = [];
    const roots = this.resolveRoots(conflicts);
    const parsedSources: ParsedSource[] = [];
    const sourceHashes: LegacySourceHash[] = [];
    const secretImportPlan: LegacySecretImportPlan[] = [];
    const providerUrls: Array<{ path: string; value: string }> = [];
    const modelIds = new Set<string>();
    const configValues: unknown[] = [];

    for (const root of roots) {
      const files = await this.discoverFiles(root);
      for (const file of files) {
        const parsed = await this.readSource(file, conflicts);
        if (!parsed) continue;
        parsedSources.push(parsed);
        sourceHashes.push(parsed.source);
        this.collectClaims(parsed, providerUrls, modelIds, configValues, secretImportPlan);
      }
    }

    const normalizedUrls = new Map<string, string[]>();
    for (const claim of providerUrls) {
      const normalized = normalizeUrl(claim.value);
      const paths = normalizedUrls.get(normalized) ?? [];
      paths.push(claim.path);
      normalizedUrls.set(normalized, paths);
    }
    if (normalizedUrls.size > 1) {
      conflicts.push({
        path: 'providers.openai.baseUrl',
        code: 'conflicting_provider_url',
        message: 'legacy sources declare different Provider URLs',
        severity: 'error',
        suggestedFix: 'Keep one normalized Provider URL and remove conflicting legacy overrides.',
      });
    }

    const dirtyRepositories = await this.inspectRepositories(roots);
    for (const repository of dirtyRepositories) {
      if (repository.dirty) {
        conflicts.push({
          path: `repositories.${repository.path}`,
          code: 'dirty_repository',
          message: 'legacy repository has uncommitted changes and will not be modified',
          severity: 'warning',
          suggestedFix: 'Commit or preserve the repository before using it as an import source.',
        });
      }
    }

    const candidate = this.buildCandidate(
      normalizedUrls.keys().next().value ?? null,
      modelIds,
      configValues,
      conflicts,
    );
    const agentClasses = [
      ...(this.options.legacyAgentClasses ?? []),
      ...(this.options.readAgentClasses ? await this.options.readAgentClasses() : []),
    ];
    this.addAgentClasses(candidate, agentClasses, conflicts);
    const parsedCandidate = parseAnyFusionConfigurationV2(candidate);
    sourceHashes.sort((left, right) => left.path.localeCompare(right.path));
    conflicts.sort((left, right) => `${left.code}:${left.path}`.localeCompare(`${right.code}:${right.path}`));

    return {
      candidate: parsedCandidate,
      sourceHashes,
      secretImportPlan: secretImportPlan.sort((left, right) => left.reference.localeCompare(right.reference)),
      conflicts,
      dirtyRepositories,
      redactedReport: { sources: sourceHashes, conflicts, repositories: dirtyRepositories },
    };
  }

  private resolveRoots(conflicts: LegacyConflict[]): string[] {
    const envRoots = [
      ['ANYFUSION_INSTALL_ROOT', this.env.ANYFUSION_INSTALL_ROOT],
      ['METACLAW_HOME', this.env.METACLAW_HOME],
      ['ANYFUSION_CONFIG_HOME', this.env.ANYFUSION_CONFIG_HOME],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
    const distinctOverrideRoots = new Set(envRoots.map(([, value]) => resolve(value)));
    if (distinctOverrideRoots.size > 1) {
      conflicts.push({
        path: 'environment',
        code: 'conflicting_root_override',
        message: 'legacy override variables select different roots',
        severity: 'error',
        suggestedFix: 'Set one explicit AnyFusion root before importing legacy configuration.',
      });
    }
    const defaultRoots = this.options.roots
      ? []
      : [
          resolve(this.env.HOME ?? process.env.HOME ?? '.', '.anyfusion'),
          resolve(this.env.HOME ?? process.env.HOME ?? '.', '.config/anyfusion'),
          resolve(this.env.HOME ?? process.env.HOME ?? '.', '.local/share/anyfusion'),
          resolve(this.env.HOME ?? process.env.HOME ?? '.', '.metaclaw'),
        ];
    const roots = [
      ...(this.options.roots ?? []),
      ...envRoots.map(([, value]) => value),
      ...defaultRoots,
    ].map(value => resolve(value));
    return [...new Set(roots)];
  }

  private async discoverFiles(root: string): Promise<string[]> {
    const candidates = new Set<string>();
    const add = async (path: string) => {
      if (await access(path).then(() => true, () => false)) candidates.add(path);
    };
    await Promise.all([
      add(join(root, 'config.yaml')),
      add(join(root, 'config.yml')),
      add(join(root, 'config.json')),
      add(join(root, '.env')),
      add(join(root, 'provider.env')),
      add(join(root, 'planner', 'models.json')),
      add(join(root, 'planner', 'settings.json')),
      add(join(root, 'pi-home', '.pi', 'agent', 'models.json')),
      add(join(root, 'pi-home', '.pi', 'agent', 'settings.json')),
      add(join(root, 'codex', 'config.toml')),
    ]);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter(entry => (
        entry.isFile()
        && (
          entry.name.endsWith('.env')
          || entry.name.endsWith('models.json')
          || entry.name.endsWith('settings.json')
        )
      ))
      .map(entry => add(join(root, entry.name))));
    return [...candidates].sort();
  }

  private async readSource(path: string, conflicts: LegacyConflict[]): Promise<ParsedSource | null> {
    try {
      const bytes = await readFile(path);
      const source: LegacySourceHash = {
        kind: path.endsWith('.env') ? 'environment' : path.endsWith('.json') ? 'json' : path.endsWith('.toml') ? 'toml' : 'config',
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
      };
      const text = bytes.toString('utf8');
      if (path.endsWith('.env')) return { source, value: parseEnv(text, path, conflicts) };
      if (path.endsWith('.json')) return { source, value: JSON.parse(text) };
      if (path.endsWith('.yaml') || path.endsWith('.yml')) return { source, value: load(text) };
      return { source, value: text };
    } catch (error) {
      conflicts.push({
        path,
        code: 'unreadable_legacy_source',
        message: `legacy source could not be read strictly: ${errorMessage(error)}`,
        severity: 'error',
        suggestedFix: 'Fix permissions or remove the unreadable legacy source before importing.',
      });
      return null;
    }
  }

  private collectClaims(
    parsed: ParsedSource,
    providerUrls: Array<{ path: string; value: string }>,
    modelIds: Set<string>,
    configValues: unknown[],
    secretImportPlan: LegacySecretImportPlan[],
  ): void {
    if (isRecord(parsed.value)) {
      configValues.push(parsed.value);
      collectProviderUrls(parsed.value, parsed.source.path, providerUrls);
      collectModelIds(parsed.value, modelIds);
      const envValues = parsed.value as Record<string, unknown>;
      const apiKey = typeof envValues.OPENAI_API_KEY === 'string' ? envValues.OPENAI_API_KEY : null;
      if (apiKey) {
        secretImportPlan.push({
          reference: 'keychain:anyfusion/imported/openai',
          sourcePath: parsed.source.path,
          sourceKey: 'OPENAI_API_KEY',
          valueSha256: createHash('sha256').update(apiKey).digest('hex'),
        });
      }
    }
    if (typeof parsed.value === 'string' && parsed.source.kind === 'toml') {
      const match = /base_url\s*=\s*"([^"]+)"/u.exec(parsed.value);
      if (match) providerUrls.push({ path: parsed.source.path, value: match[1] });
      const model = /^model\s*=\s*"([^"]+)"/mu.exec(parsed.value);
      if (model) modelIds.add(model[1]);
      const envKey = /env_key\s*=\s*"([^"]+)"/u.exec(parsed.value);
      if (envKey) {
        secretImportPlan.push({
          reference: 'keychain:anyfusion/imported/openai',
          sourcePath: parsed.source.path,
          sourceKey: envKey[1],
          valueSha256: 'external-secret',
        });
      }
    }
  }

  private buildCandidate(
    providerUrl: string | null,
    modelIds: Set<string>,
    configValues: unknown[],
    conflicts: LegacyConflict[],
  ): AnyFusionConfigurationV2 {
    for (const value of configValues) {
      if (!isRecord(value)) continue;
      for (const key of ['notifications', 'integrations', 'ui']) {
        if (value[key] && Object.keys(value[key] as object).length > 0) {
          conflicts.push({
            path: key,
            code: 'unmapped_legacy_field',
            message: `legacy field ${key} has no schema-v2 mapping`,
            severity: 'error',
            suggestedFix: 'Keep the legacy runtime active or approve a schema extension before cutover.',
          });
        }
      }
    }
    const providers: AnyFusionConfigurationV2['providers'] = providerUrl ? {
      openai: {
        protocol: 'openai-compatible' as const,
        baseUrl: providerUrl,
        apiKeyRef: 'keychain:anyfusion/imported/openai',
        region: 'international',
        enabled: true,
      },
    } : {};
    const sortedModelIds = [...modelIds].sort();
    const usedModelRefs = new Set<string>();
    const models: AnyFusionConfigurationV2['models'] = providerUrl
      ? Object.fromEntries(sortedModelIds.map((modelId) => {
        let modelRef = slugifyModelRef(modelId);
        if (usedModelRefs.has(modelRef)) {
          modelRef = `${modelRef}-${createHash('sha256').update(modelId).digest('hex').slice(0, 6)}`;
        }
        usedModelRefs.add(modelRef);
        return [modelRef, {
          providerRef: 'openai',
          modelId,
          capabilities: ['coding' as const],
          reasoning: 'medium' as const,
          enabled: true,
        }];
      }))
      : {};
    if (!providerUrl && modelIds.size > 0) {
      conflicts.push({
        path: 'models',
        code: 'missing_provider',
        message: 'legacy models have no unambiguous Provider URL',
        severity: 'error',
        suggestedFix: 'Configure one Provider URL before importing models.',
      });
    }
    const defaultModelRef = Object.keys(models).sort()[0] ?? null;
    const harnesses: AnyFusionConfigurationV2['harnesses'] = {
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
        enabled: true,
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
        enabled: true,
      },
    };
    const agentClasses: AnyFusionConfigurationV2['agentClasses'] = defaultModelRef ? {
      planner: {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef: defaultModelRef },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: ['metaclaw-planner'],
        mcpServers: ['metaclaw-planner'],
        plugins: [],
        generatedRuntimeRef: 'planner',
        enabled: true,
      },
      'codex-cli': {
        kind: 'executor',
        harnessRef: 'codex-cli',
        modelPolicy: { mode: 'fixed', modelRef: defaultModelRef },
        permissionProfileRef: 'workspace-engineering',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['repository implementation', 'tests', 'engineering documentation'],
        avoidUseCases: ['current public-web research requiring source-backed delivery'],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'codex-cli',
        enabled: true,
      },
      'pi-agent': {
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef: defaultModelRef },
        permissionProfileRef: 'public-web-research',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['current public-web research', 'source verification'],
        avoidUseCases: ['repository modification and engineering verification'],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-agent',
        enabled: true,
      },
    } : {};
    const permissionProfiles: AnyFusionConfigurationV2['permissionProfiles'] = {
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
    };
    return {
      schemaVersion: 2,
      providers,
      models,
      harnesses,
      agentClasses,
      permissionProfiles,
      runtimePolicy: {},
      gateway: {},
    };
  }

  private addAgentClasses(
    candidate: AnyFusionConfigurationV2,
    records: LegacyAgentClassRecord[],
    conflicts: LegacyConflict[],
  ): void {
    for (const record of records) {
      const model = candidate.models[record.modelRef];
      if (!model) {
        conflicts.push({
          path: `agentClasses.${record.id}.modelRef`,
          code: 'missing_model_profile',
          message: `AgentClass references missing ModelProfile: ${record.modelRef}`,
          severity: 'error',
          suggestedFix: 'Import or define the referenced ModelProfile first.',
        });
        continue;
      }
      const command = record.command ?? (record.kind === 'planner' ? 'planner' : undefined);
      if (record.kind === 'executor' && command !== 'codex' && command !== 'pi') {
        conflicts.push({
          path: `agentClasses.${record.id}.command`,
          code: 'unknown_custom_command',
          message: `custom Executor command is not registered: ${command ?? '(missing)'}`,
          severity: 'error',
          suggestedFix: 'Use a registered Harness driver or approve an adapter extension.',
        });
        continue;
      }
      const harnessRef = `${record.id}-harness`;
      const isPi = command === 'pi';
      candidate.harnesses[harnessRef] = record.kind === 'planner'
        ? {
          kind: 'planner',
          transport: 'local-process',
          commandRef: 'release:planner',
          args: [],
          driverId: 'anyfusion-planner-host-v2',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: true,
          enabled: true,
        }
        : {
          kind: 'executor',
          transport: 'local-cli',
          command: command!,
          args: [],
          driverId: isPi ? 'pi-cli' : 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: true,
          enabled: true,
        };
      if (record.kind === 'executor') {
        const profileId = record.permissionProfileId ?? (isPi ? 'public-web-research' : 'workspace-engineering');
        const profileRef = `${record.id}-permission`;
        candidate.permissionProfiles[profileRef] = {
          profileId,
          version: 1,
          parameters: {},
        };
        candidate.agentClasses[record.id] = {
          kind: 'executor',
          harnessRef,
          modelPolicy: { mode: 'fixed', modelRef: record.modelRef },
          permissionProfileRef: profileRef,
          routingCapabilities: [isPi ? 'current-web-research' : 'workspace-engineering'],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: isPi
            ? ['public-web-search', 'public-web-fetch', 'source-citation']
            : ['workspace-read-write', 'workspace-command-validation'],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: record.id,
          enabled: true,
        };
      } else {
        candidate.agentClasses[record.id] = {
          kind: 'planner',
          harnessRef,
          modelPolicy: { mode: 'fixed', modelRef: record.modelRef },
          routingCapabilities: [],
          primaryUseCases: [],
          avoidUseCases: [],
          plannerAffordances: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          generatedRuntimeRef: record.id,
          enabled: true,
        };
      }
    }
  }

  private async inspectRepositories(roots: string[]): Promise<LegacyRepositoryStatus[]> {
    const candidates = new Set<string>();
    for (const root of roots) {
      for (const path of [
        join(root, 'planner'),
        join(root, 'planner', 'AnyFusion-Pi'),
        join(root, '..', 'AnyFusion-Pi'),
      ]) {
        if (await access(path).then(() => true, () => false)) candidates.add(resolve(path));
      }
    }
    if (this.env.ANYFUSION_PI_SOURCE_ROOT) {
      candidates.add(resolve(this.env.ANYFUSION_PI_SOURCE_ROOT));
    }
    const statuses = await Promise.all([...candidates].map(path => this.inspectGit(path)));
    return statuses.filter(status => status.exists);
  }
}

async function inspectGit(path: string): Promise<LegacyRepositoryStatus> {
  try {
    const [head, status] = await Promise.all([
      execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', path, 'status', '--porcelain']),
    ]);
    return {
      path,
      exists: true,
      dirty: Boolean(status.stdout.trim()),
      head: head.stdout.trim(),
      statusHash: createHash('sha256').update(status.stdout).digest('hex'),
    };
  } catch {
    return { path, exists: false, dirty: false, head: null, statusHash: null };
  }
}

function parseEnv(text: string, path: string, conflicts: LegacyConflict[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [lineNumber, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      conflicts.push({
        path: `${path}:${lineNumber + 1}`,
        code: 'malformed_env',
        message: 'legacy environment source contains a malformed assignment',
        severity: 'error',
        suggestedFix: 'Use KEY=value syntax or remove the malformed line.',
      });
      continue;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    result[key] = rawValue.replace(/^(['"])(.*)\1$/u, '$2');
  }
  return result;
}

function collectProviderUrls(
  value: Record<string, unknown>,
  path: string,
  claims: Array<{ path: string; value: string }>,
): void {
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && /^(?:OPENAI_BASE_URL|ANYFUSION_PROVIDER_URL|baseUrl|base_url|url)$/u.test(key)) {
      if (/^https?:\/\//u.test(nested)) claims.push({ path: `${path}:${key}`, value: nested });
    }
    if (isRecord(nested)) collectProviderUrls(nested, `${path}.${key}`, claims);
  }
}

function collectModelIds(value: Record<string, unknown>, modelIds: Set<string>): void {
  const models = value.models;
  if (Array.isArray(models)) {
    for (const model of models) {
      if (isRecord(model) && typeof model.id === 'string' && model.id.trim()) modelIds.add(model.id.trim());
    }
  }
  if (isRecord(models)) {
    for (const [key, model] of Object.entries(models)) {
      if (typeof model === 'string') modelIds.add(model);
      else if (isRecord(model) && typeof model.id === 'string') modelIds.add(model.id);
      else if (key !== 'providers') modelIds.add(key);
    }
  }
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) collectModelIds(nested, modelIds);
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function slugifyModelRef(modelId: string): string {
  const slug = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = /^[a-z]/.test(slug) ? slug : (slug ? `model-${slug}` : 'model');
  return base || 'model';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
