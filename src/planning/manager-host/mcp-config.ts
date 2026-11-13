/**
 * Manager MCP configuration (ADR-0055 D6).
 *
 * The Manager reads Task, artifact and memory facts through MetaWork's own MCP
 * server. MetaWork's Manager extension explicitly reads this configuration;
 * upstream Pi does not discover MCP servers from this file on its own.
 * Composition writes it into the isolated Manager home and never reads a
 * user-level MCP configuration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ManagerMcpConfigInput {
  /** Pi agent directory owned by MetaWork (the isolated config root). */
  readonly configDir: string;
  /** Absolute path to the compiled `planner-mcp.js` entry point. */
  readonly serverEntry: string;
  /** Node executable; the Manager and the MCP server share one runtime. */
  readonly nodeCommand?: string;
  /** Identity the server must query with. Never a model-supplied value. */
  readonly env: Readonly<Record<string, string>>;
  readonly serverName?: string;
}

export interface ManagerMcpConfig {
  readonly path: string;
  readonly serverName: string;
  readonly document: Record<string, unknown>;
}

export function writeManagerMcpConfig(input: ManagerMcpConfigInput): ManagerMcpConfig {
  const serverName = input.serverName ?? 'metawork';
  const document = {
    mcpServers: {
      [serverName]: {
        command: input.nodeCommand ?? process.execPath,
        args: [input.serverEntry],
        env: { ...input.env },
        enabled: true,
      },
    },
  };
  mkdirSync(input.configDir, { recursive: true });
  const path = join(input.configDir, 'mcp.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return { path, serverName, document };
}

/** Resolves the compiled MCP entry point for the running install. */
export function resolvePlannerMcpEntry(moduleRoot: string): string {
  return join(moduleRoot, 'dist', 'planner-mcp.js');
}
