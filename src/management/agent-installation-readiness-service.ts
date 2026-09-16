import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { safeHostEnvironment } from '../executor/harness-driver.js';
import {
  AGENT_INSTALLATION_CATALOG,
  type AgentInstallationDefinition,
  type SupportedAgentId,
} from './agent-installation-catalog.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_VERSION_LENGTH = 120;
const MAX_DETAIL_LENGTH = 240;

export type VersionProbeResult =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string };

export type VersionProbeRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<VersionProbeResult>;

export type AgentInstallStatus = 'checking' | 'installed' | 'missing' | 'broken';

export interface AgentReadiness {
  agentId: SupportedAgentId;
  required: boolean;
  displayName: string;
  status: AgentInstallStatus;
  version: string | null;
  detail: string | null;
  installUrl: string;
  checkedAt: string;
}

export interface AgentInstallationReadinessServiceDeps {
  probe?: VersionProbeRunner;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  resolveDisplayName?: (agentId: SupportedAgentId) => string | undefined;
  catalog?: readonly AgentInstallationDefinition[];
}

export class AgentInstallationReadinessService {
  private readonly probe: VersionProbeRunner;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly resolveDisplayName: (agentId: SupportedAgentId) => string | undefined;
  private readonly catalog: readonly AgentInstallationDefinition[];
  private readonly listeners = new Set<(agents: readonly AgentReadiness[]) => void>();
  private state: readonly AgentReadiness[];
  private lastRefreshAt = 0;
  private refreshPromise: Promise<readonly AgentReadiness[]> | null = null;

  constructor(deps: AgentInstallationReadinessServiceDeps = {}) {
    this.probe = deps.probe ?? defaultVersionProbe;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveDisplayName = deps.resolveDisplayName ?? (() => undefined);
    this.catalog = deps.catalog ?? AGENT_INSTALLATION_CATALOG;
    this.state = this.catalog.map(definition => this.initialState(definition));
  }

  getState(): readonly AgentReadiness[] {
    return this.state;
  }

  subscribe(listener: (agents: readonly AgentReadiness[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(input: { force?: boolean } = {}): Promise<readonly AgentReadiness[]> {
    const force = input.force === true;
    if (!force && this.lastRefreshAt > 0 && this.now() - this.lastRefreshAt < this.ttlMs) {
      return this.state;
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.state = this.catalog.map(definition => ({
      ...this.initialState(definition),
      status: 'checking',
    }));
    this.publish();
    const refresh = Promise.all(this.catalog.map(definition => this.probeDefinition(definition)))
      .then(next => {
        this.state = next;
        this.lastRefreshAt = this.now();
        this.publish();
        return this.state;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    this.refreshPromise = refresh;
    return refresh;
  }

  isRequiredAgentReady(): boolean {
    return this.catalog
      .filter(definition => definition.required)
      .every(definition => this.state
        .find(agent => agent.agentId === definition.agentId)?.status === 'installed');
  }

  private initialState(definition: AgentInstallationDefinition): AgentReadiness {
    return {
      agentId: definition.agentId,
      required: definition.required,
      displayName: this.resolveDisplayName(definition.agentId)?.trim()
        || (definition.agentId === 'pi-agent' ? '智能体 1' : '智能体 2'),
      status: 'checking',
      version: null,
      detail: null,
      installUrl: definition.installUrl,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private async probeDefinition(
    definition: AgentInstallationDefinition,
  ): Promise<AgentReadiness> {
    const checkedAt = new Date(this.now()).toISOString();
    let result: VersionProbeResult;
    try {
      result = await this.probe(definition.command, definition.args, this.timeoutMs);
    } catch (error) {
      result = {
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.kind === 'exit' && result.code === 0) {
      return {
        ...this.initialState(definition),
        status: 'installed',
        version: firstOutputLine(result.stdout),
        checkedAt,
      };
    }
    return {
      ...this.initialState(definition),
      status: result.kind === 'missing' ? 'missing' : 'broken',
      detail: boundedDetail(detailForProbeResult(result)),
      checkedAt,
    };
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

async function defaultVersionProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<VersionProbeResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      env: safeHostEnvironment(process.env),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    return {
      kind: 'exit',
      code: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const candidate = error as {
      code?: string | number;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (candidate.code === 'ENOENT') return { kind: 'missing' };
    if (candidate.killed || candidate.signal === 'SIGTERM') return { kind: 'timeout' };
    return {
      kind: 'exit',
      code: typeof candidate.code === 'number' ? candidate.code : 1,
      stdout: String(candidate.stdout ?? ''),
      stderr: String(candidate.stderr ?? candidate.message ?? ''),
    };
  }
}

function firstOutputLine(output: string): string {
  return output.trim().split(/\r?\n/u)[0]?.trim().slice(0, MAX_VERSION_LENGTH) || 'installed';
}

function detailForProbeResult(result: VersionProbeResult): string {
  if (result.kind === 'exit') {
    return result.stderr.trim() || `command exited with ${result.code}`;
  }
  if (result.kind === 'missing') return 'command not found';
  if (result.kind === 'timeout') return 'version check timed out';
  return result.detail;
}

function boundedDetail(detail: string): string {
  const redacted = redactSensitiveText(detail).trim();
  return redacted.slice(0, MAX_DETAIL_LENGTH);
}
