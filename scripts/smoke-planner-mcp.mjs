import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const expectedTools = [
  'search_tasks',
  'get_task_context',
  'get_current_session_context',
  'get_planning_context',
  'get_session_interaction',
  'get_runtime_state',
  'get_executor_diagnostics',
  'list_executor_status',
];

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/app/dist/planner-mcp.js'],
  env: {
    ...process.env,
    METACLAW_PLANNER_SESSION_ID: process.env.METACLAW_PLANNER_SESSION_ID ?? 'sess_planner_mcp_smoke',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'metaclaw-planner-mcp-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) {
    throw new Error(`unexpected planner tools: ${names.join(', ')}`);
  }
  const state = await client.callTool({ name: 'get_runtime_state', arguments: {} });
  if (state.isError) throw new Error('get_runtime_state returned an MCP error');
  const planningContext = await client.callTool({ name: 'get_planning_context', arguments: {} });
  if (planningContext.isError) throw new Error('get_planning_context returned an MCP error');
  const diagnostics = await client.callTool({
    name: 'get_executor_diagnostics',
    arguments: { limit: 1 },
  });
  if (diagnostics.isError) throw new Error('get_executor_diagnostics returned an MCP error');
  process.stdout.write(`planner-mcp-smoke-ok tools=${names.length}\n`);
} finally {
  await client.close();
}
