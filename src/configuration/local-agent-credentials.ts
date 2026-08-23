import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderDefinition } from './types.js';
import {
  assertSecretReference,
  type SecretReference,
  type SecretStore,
} from './secret-store.js';

export interface LocalAgentCredentialImportInput {
  home?: string;
  codexHomes?: readonly string[];
  piHomes?: readonly string[];
  plannerHomes?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  providers: Record<string, ProviderDefinition>;
  secretStore: SecretStore;
}

export interface LocalAgentCredentialImportResult {
  imported: string[];
  skipped: string[];
}

interface CredentialCandidate {
  providerRef?: string;
  baseUrl?: string;
  apiKey: string;
}

export async function importLocalAgentCredentials(
  input: LocalAgentCredentialImportInput,
): Promise<LocalAgentCredentialImportResult> {
  return importCandidatesForProviders(
    await readLocalAgentCredentialCandidates(
      input,
      input.environment ?? process.env,
    ),
    input.providers,
    input.secretStore,
  );
}

export async function importLocalAgentCredentialsForRefs(input: {
  home?: string;
  codexHomes?: readonly string[];
  piHomes?: readonly string[];
  plannerHomes?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  providers: Record<string, SecretReference>;
  secretStore: SecretStore;
}): Promise<LocalAgentCredentialImportResult> {
  const candidates = await readLocalAgentCredentialCandidates(
    input,
    input.environment ?? process.env,
  );
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [providerRef, reference] of Object.entries(input.providers)) {
    const candidate = candidates.find(value => matchesProviderRef(providerRef, value));
    if (!candidate) continue;
    try {
      const existing = await input.secretStore.get(reference);
      if (existing.trim() === candidate.apiKey) {
        skipped.push(providerRef);
        continue;
      }
    } catch {
      // A missing SecretStore entry is the import case.
    }
    await input.secretStore.put(reference, candidate.apiKey);
    imported.push(providerRef);
  }
  return { imported, skipped };
}

async function importCandidatesForProviders(
  candidates: CredentialCandidate[],
  providers: Record<string, ProviderDefinition>,
  secretStore: SecretStore,
): Promise<LocalAgentCredentialImportResult> {
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const [providerRef, provider] of Object.entries(providers)) {
    if (!provider.enabled) continue;
    assertSecretReference(provider.apiKeyRef);
    const candidate = candidates.find(value => matchesProvider(providerRef, provider, value));
    if (!candidate) continue;

    try {
      const existing = await secretStore.get(provider.apiKeyRef);
      if (existing.trim() === candidate.apiKey) {
        skipped.push(providerRef);
        continue;
      }
    } catch {
      // A missing SecretStore entry is the import case.
    }

    await secretStore.put(provider.apiKeyRef, candidate.apiKey);
    imported.push(providerRef);
  }

  return { imported, skipped };
}

async function readLocalAgentCredentialCandidates(
  input: {
    home?: string;
    codexHomes?: readonly string[];
    piHomes?: readonly string[];
    plannerHomes?: readonly string[];
  },
  environment: NodeJS.ProcessEnv,
): Promise<CredentialCandidate[]> {
  const home = input.home ?? homedir();
  const codexHomes = uniquePaths([
    join(home, '.codex'),
    ...(input.codexHomes ?? []),
  ]);
  const piHomes = uniquePaths([
    join(home, '.pi'),
    ...(input.piHomes ?? []),
  ]);
  const plannerHomes = uniquePaths(input.plannerHomes ?? []);
  return [
    ...(await Promise.all(codexHomes.map(path => readCodexCredentials(path, environment)))).flat(),
    ...(await Promise.all(piHomes.map(path => readPiCredentials(path, environment)))).flat(),
    ...(await Promise.all(plannerHomes.map(path => readModelCredentials(path, environment)))).flat(),
  ];
}

async function readCodexCredentials(
  codexHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialCandidate[]> {
  const [auth, config] = await Promise.all([
    readJson(join(codexHome, 'auth.json')),
    readText(join(codexHome, 'config.toml')),
  ]);
  if (!config) return [];

  const providerRef = matchValue(config, /^\s*model_provider\s*=\s*"([^"]+)"/mu);
  const providerSection = providerRef
    ? matchSection(config, `model_providers.${providerRef}`)
    : '';
  const baseUrl = matchValue(providerSection, /^\s*base_url\s*=\s*"([^"]+)"/mu);
  const envKey = matchValue(providerSection, /^\s*env_key\s*=\s*"([^"]+)"/mu)
    ?? 'OPENAI_API_KEY';
  const environmentKey = environment[envKey]?.trim();
  const authKey = auth && typeof auth[envKey] === 'string' ? auth[envKey].trim() : '';
  const apiKey = environmentKey || authKey;
  return apiKey ? [{ providerRef, baseUrl, apiKey }] : [];
}

async function readPiCredentials(
  piHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialCandidate[]> {
  return readModelCredentials(join(piHome, 'agent'), environment);
}

async function readModelCredentials(
  agentHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialCandidate[]> {
  const [models, auth] = await Promise.all([
    readJson(join(agentHome, 'models.json')),
    readJson(join(agentHome, 'auth.json')),
  ]);
  const providers = models?.providers;
  const candidates: CredentialCandidate[] = [];
  if (isRecord(providers)) {
    for (const [providerRef, value] of Object.entries(providers)) {
      if (!isRecord(value)) continue;
      const configuredKey = resolveCredential(
        typeof value.apiKey === 'string' ? value.apiKey : undefined,
        environment,
      );
      const authValue = isRecord(auth?.[providerRef]) ? auth[providerRef] : null;
      const authKey = resolveCredential(
        authValue && typeof authValue.key === 'string' ? authValue.key : undefined,
        environment,
      );
      const apiKey = configuredKey || authKey;
      if (!isUsableCredential(apiKey)) continue;
      candidates.push({
        providerRef,
        baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
        apiKey,
      });
    }
  }
  if (isRecord(auth)) {
    for (const [providerRef, value] of Object.entries(auth)) {
      if (!isRecord(value) || typeof value.key !== 'string') continue;
      const apiKey = resolveCredential(value.key, environment);
      if (!isUsableCredential(apiKey)) continue;
      if (candidates.some(candidate => candidate.providerRef === providerRef)) continue;
      candidates.push({ providerRef, apiKey });
    }
  }
  return candidates;
}

function matchesProvider(
  providerRef: string,
  provider: ProviderDefinition,
  candidate: CredentialCandidate,
): boolean {
  if (matchesProviderRef(providerRef, candidate)) {
    return true;
  }
  return Boolean(
    candidate.baseUrl
    && normalizeUrl(candidate.baseUrl) === normalizeUrl(provider.baseUrl),
  );
}

function matchesProviderRef(providerRef: string, candidate: CredentialCandidate): boolean {
  return Boolean(
    candidate.providerRef
    && (
      candidate.providerRef === providerRef
      || normalizeProviderRef(candidate.providerRef) === normalizeProviderRef(providerRef)
    ),
  );
}

function normalizeProviderRef(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '')
    .replace(/coding$/u, '');
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function matchSection(text: string, sectionName: string): string {
  const lines = text.split(/\r?\n/u);
  const header = `[${sectionName}]`;
  const start = lines.findIndex(line => line.trim() === header);
  if (start < 0) return '';

  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) break;
    sectionLines.push(line);
  }
  return sectionLines.join('\n');
}

function matchValue(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1]?.trim();
}

function isUsableCredential(value: string): boolean {
  return value.length > 0 && !value.startsWith('$');
}

function resolveCredential(value: string | undefined, environment: NodeJS.ProcessEnv): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed.startsWith('$')) return trimmed;
  return environment[trimmed.slice(1)]?.trim() ?? '';
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(path => path.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
