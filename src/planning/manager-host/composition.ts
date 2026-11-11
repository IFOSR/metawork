/**
 * Composition helper for the Manager planning transport (ADR-0055 D6).
 *
 * Everything here is decided by MetaWork, not by the Manager: which Pi binary
 * runs, which home/config/session roots it gets, and which extension is loaded.
 * The packaged Pi comes from the release manifest pin (P2-B1); the extension is
 * shipped next to the compiled entry points.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync as exists } from 'node:fs';
import { buildManagerEnvironment } from './environment.js';
import { resolvePlannerMcpEntry, writeManagerMcpConfig } from './mcp-config.js';
import {
  managerProviderEnv,
  writeManagerProviderConfig,
  type ManagerProviderConfiguration,
} from './provider-config.js';
import { ManagerPlanningAgent, type ManagerPlanningAgentOptions, type ManagerTurnScope } from './manager-planning-agent.js';
import type { PlanningContext } from '../planning-types.js';
import { resolveExecutorTool } from '../../utils/executor-tool-path.js';

export interface ManagerAgentCompositionInput {
  /** Runtime root that owns the Manager home (`HOME`, config and sessions). */
  readonly runtimeRoot: string;
  /** Upstream Pi executable the release pinned at build time. */
  readonly piCommand?: string;
  /** Provider/secret variables the configuration chose to pass explicitly. */
  readonly explicitEnv?: Readonly<Record<string, string>>;
  /** Workspace boundary owner (Conversation binding). */
  readonly resolveScope: (context: PlanningContext) => ManagerTurnScope | Promise<ManagerTurnScope>;
  readonly moduleRoot?: string;
  readonly turnTimeoutMs?: number;
  readonly onDiagnostic?: (line: string) => void;
  /** Env for MetaWork's MCP server (session/conversation identity, DB path). */
  readonly mcpEnv?: Readonly<Record<string, string>>;
  /**
   * Active configuration revision plus the provider keys resolved from the
   * SecretStore. When supplied, the Manager home gets `models.json` and
   * `settings.json` rendered by MetaWork instead of a user-level Pi config.
   */
  readonly providerConfig?: {
    readonly configuration: ManagerProviderConfiguration;
    readonly agentClassId: string;
    readonly apiKeys: Readonly<Record<string, string>>;
  };
  readonly resolvePermissionContext?: (request: import('../../resource/types.js').NormalizedCapabilityRequest) => Promise<PlanningContext>;
  readonly beforeModelCall?: ManagerPlanningAgentOptions['beforeModelCall'];
}

export interface ManagerAgentComposition {
  readonly planningAgent: ManagerPlanningAgent;
  readonly command: string;
  readonly args: readonly string[];
  readonly environmentDropped: readonly string[];
  /** Path of the Manager-only `mcp.json`, when the MCP server is available. */
  readonly mcpConfigPath?: string;
  readonly managerPermissionJudge?: import('../../resource/manager-permission-judge.js').ManagerPermissionJudge;
}

export function resolveManagerExtensionPath(moduleRoot?: string): string {
  const root = moduleRoot ?? process.cwd();
  const candidates = [
    join(root, 'dist', 'pi-manager', 'index.ts'),
    join(root, 'pi-manager', 'index.ts'),
    // Source tree fallback only when the caller did not name a module root, so a
    // packaged install cannot silently fall back to repository sources.
    ...(moduleRoot === undefined
      ? [fileURLToPath(new URL('./extension/index.ts', import.meta.url))]
      : []),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(
      'packaged Manager extension not found: build the runtime so dist/pi-manager/index.ts exists',
    );
  }
  return found;
}

export function composeManagerPlanningAgent(
  input: ManagerAgentCompositionInput,
): ManagerAgentComposition {
  const managerHome = resolve(input.runtimeRoot, 'manager');
  const configDir = join(managerHome, 'config');
  const sessionDir = join(managerHome, 'sessions');
  // The Manager runs here, never in the user Workspace: project-local
  // AGENTS/skills/extensions must not shape planning semantics.
  const managerWorkspace = join(managerHome, 'workspace');
  mkdirSync(managerWorkspace, { recursive: true });
  const extension = resolveManagerExtensionPath(input.moduleRoot);
  const providerEnv = input.providerConfig
    ? managerProviderEnv(input.providerConfig.configuration, input.providerConfig.apiKeys)
    : {};
  if (input.providerConfig) {
    writeManagerProviderConfig({
      configDir,
      configuration: input.providerConfig.configuration,
      agentClassId: input.providerConfig.agentClassId,
      providerSecrets: providerEnv,
    });
  }
  const environment = () => buildManagerEnvironment({
    managerHome,
    configDir,
    sessionDir,
    explicit: {
      ...(input.providerConfig ? managerProviderEnv(input.providerConfig.configuration, input.providerConfig.apiKeys) : {}),
      ...(input.explicitEnv ?? {}),
      METAWORK_MANAGER_WORKSPACE: process.cwd(),
      ...(input.mcpEnv ? { METAWORK_MANAGER_MCP_CONFIG: join(configDir, 'mcp.json') } : {}),
    },
  });
  const { dropped } = environment();
  // The Manager reads Task/artifact/memory facts through MetaWork's MCP server.
  // The config lives in the isolated Manager home, never in the user's Pi home.
  const mcpEntry = resolvePlannerMcpEntry(input.moduleRoot ?? process.cwd());
  let mcpPath: string | null = null;
  if (exists(mcpEntry)) {
    mcpPath = writeManagerMcpConfig({
      configDir,
      serverEntry: mcpEntry,
      env: {
        ...(input.mcpEnv ?? {}),
        METAWORK_MANAGER_HOME: managerHome,
      },
    }).path;
  }
  const command = resolveExecutorTool(input.piCommand?.trim() || 'pi', { releaseRoot: input.moduleRoot });
  const args = [
    '--mode', 'rpc',
    // Ignore project-local files and skill/extensions discovery so only
    // MetaWork's extension defines the Manager tool surface.
    '--no-approve',
    '--no-skills',
    '--no-extensions',
    '--extension', extension,
  ];
  const planningAgent = new ManagerPlanningAgent({
    command,
    args,
    env: () => environment().env,
    cwd: managerWorkspace,
    sessionDir,
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
    resolveScope: input.resolveScope,
    ...(input.beforeModelCall ? { beforeModelCall: input.beforeModelCall } : {}),
  });
  return {
    planningAgent,
    command,
    args,
    environmentDropped: dropped,
    ...(mcpPath ? { mcpConfigPath: mcpPath } : {}),
    ...(input.resolvePermissionContext ? { managerPermissionJudge: {
      judge: async (request: import('../../resource/types.js').NormalizedCapabilityRequest, options?: { signal?: AbortSignal }) => {
        const context = await input.resolvePermissionContext!(request);
        return planningAgent.judgePermission({ ...context,
          signal: options?.signal && context.signal ? AbortSignal.any([options.signal, context.signal])
            : options?.signal ?? context.signal,
        }, request);
      },
    } } : {}),
  };
}
