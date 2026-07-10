import { spawn } from 'node:child_process';

const schemaPath = process.env.METACLAW_PLANNER_SCHEMA_PATH
  ?? '/opt/metaclaw/schema/planning-agent-plan-v2.schema.json';
const codexHome = process.env.METACLAW_PLANNER_CODEX_HOME
  ?? '/var/lib/metaclaw/codex/planner';
const prompt = [
  '$metaclaw-planner',
  'The user asks which MetaClaw tasks currently exist.',
  'Call get_runtime_state before returning a PlanningAgentPlan v2 status_query JSON.',
  'Do not create or modify state, and set task.priority to null.',
].join('\n');
const args = [
  'exec',
  '--sandbox', 'read-only',
  '--ephemeral',
  '--skip-git-repo-check',
  '--json',
  '--output-schema', schemaPath,
  '--color', 'never',
  '--disable', 'apps',
  '--disable', 'multi_agent',
  '--disable', 'goals',
  '--disable', 'guardian_approval',
  prompt,
];

const child = spawn('codex', args, {
  cwd: process.env.METACLAW_PLANNER_WORKDIR ?? '/var/empty/metaclaw-planner',
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    METACLAW_PLANNER_SESSION_ID: process.env.METACLAW_PLANNER_SESSION_ID
      ?? 'sess_planner_codex_smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});

const events = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const finalMessage = events.find(event => event.item?.type === 'agent_message');
const toolCall = events.find(event => {
  const item = event.item ?? {};
  const toolName = item.tool_name ?? item.tool ?? item.name;
  return event.type === 'item.completed'
    && String(item.type ?? '').includes('mcp_tool')
    && toolName === 'get_runtime_state';
});
if (code !== 0 || !finalMessage || !toolCall || toolCall.item?.status !== 'completed') {
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  throw new Error(`Planner Codex smoke failed (exit=${code}, final=${Boolean(finalMessage)}, tool=${Boolean(toolCall)})`);
}

process.stdout.write(`planner-codex-smoke-ok tool=${toolCall.item.tool_name ?? toolCall.item.tool ?? toolCall.item.name}\n`);
