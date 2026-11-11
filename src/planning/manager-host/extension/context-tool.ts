import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const CONTEXT_TOOL = 'read_metawork_context';
const READ_METHODS = ['get_planning_context', 'get_runtime_state', 'get_task_context',
  'get_current_session_context', 'get_session_interaction', 'search_tasks',
  'list_executor_status', 'get_executor_diagnostics', 'get_memory_context', 'list_memory_assets'] as const;

/** Only the host-owned read service is reachable. Identity never comes from model arguments. */
export async function readMetaWorkContext(params: { method: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) {
  if (!(READ_METHODS as readonly string[]).includes(params.method)) throw new Error('manager_context_method_forbidden');
  const configPath = process.env.METAWORK_MANAGER_MCP_CONFIG;
  if (!configPath) throw new Error('manager_context_unavailable');
  const config = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers?.metawork;
  if (!config?.command || !Array.isArray(config.args)) throw new Error('manager_context_configuration_invalid');
  const identity = Object.fromEntries([
    'METACLAW_PLANNER_SESSION_ID', 'METACLAW_PLANNER_CONVERSATION_ID',
    'METACLAW_CONFIGURATION_REVISION', 'METAWORK_PLANNER_ATTACHMENTS_JSON',
  ].map(key => [key, process.env[key] ?? '']));
  const transport = new StdioClientTransport({ command: config.command, args: config.args,
    env: { ...config.env, ...identity }, stderr: 'pipe' });
  const client = new Client({ name: 'metawork-manager-context', version: '1.0.0' });
  // Open one bounded connection per read, and close it even on error/cancel.
  // Provider credentials from the Manager environment are not inherited.
  const bounded = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  const abort = () => { void transport.close(); };
  bounded.addEventListener('abort', abort, { once: true });
  try {
    bounded.throwIfAborted();
    await client.connect(transport);
    transport.stderr?.on('data', () => undefined);
    return await client.callTool({ name: params.method, arguments: params.arguments ?? {} }, undefined,
      { timeout: 15_000, signal: bounded });
  } finally {
    bounded.removeEventListener('abort', abort);
    await client.close();
  }
}

export function managerContextTool() {
  return {
    name: CONTEXT_TOOL, label: '读取任务与记忆上下文',
    description: 'Read trusted MetaWork facts. Before planning work call get_planning_context and get_memory_context. For previous work call get_runtime_state/get_task_context. Arguments are the selected read method parameters, never account/session identity. Memory results are bounded previews; select relevant memoryId + revision as contextRefs to deliver source content to an Executor.',
    parameters: { type: 'object', properties: { method: { type: 'string', enum: READ_METHODS },
      arguments: { type: 'object', additionalProperties: true } }, required: ['method'], additionalProperties: false },
    async execute(_id: string, params: { method: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) {
      const result = await readMetaWorkContext(params, signal);
      return { content: result.content, isError: result.isError ?? false, details: {} };
    },
  };
}
