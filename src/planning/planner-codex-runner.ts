import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { truncateText } from '../utils/truncate-text.js';
import type { PlanningContext } from './planning-types.js';

export interface PlannerToolCallTrace {
  sequence: number;
  toolName: string;
  status: 'completed' | 'failed';
  argumentsSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
}

export interface PlannerRunResult {
  output: string;
  toolCalls: PlannerToolCallTrace[];
  durationMs: number;
}

export interface PlannerCodexRunner {
  run(prompt: string, context: PlanningContext): Promise<PlannerRunResult>;
}

type SpawnFn = typeof spawn;

export interface CodexPlannerRunnerDeps {
  command?: string;
  spawn?: SpawnFn;
  codexHome?: string;
  schemaPath?: string;
  cwd?: string;
}

export class CodexPlannerRunner implements PlannerCodexRunner {
  constructor(private readonly deps: CodexPlannerRunnerDeps = {}) {}

  async run(prompt: string, context: PlanningContext): Promise<PlannerRunResult> {
    const startedAt = Date.now();
    const command = this.deps.command ?? 'codex';
    const codexHome = this.deps.codexHome
      ?? process.env.METACLAW_PLANNER_CODEX_HOME
      ?? join(process.env.METACLAW_HOME ?? tmpdir(), 'codex', 'planner');
    const schemaPath = this.deps.schemaPath
      ?? process.env.METACLAW_PLANNER_SCHEMA_PATH
      ?? '/opt/metaclaw/schema/planning-agent-plan-v2.schema.json';
    const cwd = this.deps.cwd ?? process.env.METACLAW_PLANNER_WORKDIR ?? tmpdir();

    return new Promise((resolve, reject) => {
      const proc = (this.deps.spawn ?? spawn)(command, buildPlannerCodexArgs(prompt, schemaPath), {
        cwd,
        timeout: context.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          METACLAW_PLANNER_SESSION_ID: context.request.sessionId,
          METACLAW_PLANNER_REQUEST_SOURCE: context.request.source,
        },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(
            `Codex planner exited with ${code ?? 'unknown'}: ${truncateText(redactSensitiveText(stderr), 500)}`,
          ));
          return;
        }
        try {
          const parsed = parseCodexJsonl(stdout);
          resolve({ ...parsed, durationMs: Date.now() - startedAt });
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function buildPlannerCodexArgs(prompt: string, schemaPath: string): string[] {
  return [
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
}

export function parseCodexJsonl(stdout: string): Omit<PlannerRunResult, 'durationMs'> {
  const events = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }).filter((event): event is Record<string, unknown> => event !== null);
  const toolCalls: PlannerToolCallTrace[] = [];
  let output = '';

  for (const event of events) {
    const item = isRecord(event.item) ? event.item : event;
    const eventType = String(event.type ?? '');
    const itemType = String(item.type ?? event.type ?? '');
    if (itemType === 'agent_message' || itemType === 'message') {
      const text = extractText(item);
      if (text) output = text;
    }
    if (
      (eventType === 'item.completed' || eventType === 'item.failed')
      && itemType.includes('mcp')
      && itemType.includes('tool')
    ) {
      toolCalls.push({
        sequence: toolCalls.length + 1,
        toolName: String(item.tool_name ?? item.tool ?? item.name ?? item.server ?? 'unknown'),
        status: isFailedToolEvent(event, item) ? 'failed' : 'completed',
        argumentsSummary: summarizeValue(item.arguments ?? item.input),
        resultSummary: summarizeValue(item.result ?? item.output),
      });
    }
  }

  if (!output) {
    const finalEvent = [...events].reverse().find(event => typeof event.response === 'string' || typeof event.output === 'string');
    output = finalEvent ? String(finalEvent.response ?? finalEvent.output) : '';
  }
  if (!output) {
    const eventTypes = events.slice(-8).map((event) => {
      const item = isRecord(event.item) ? event.item : null;
      return `${String(event.type ?? 'unknown')}/${String(item?.type ?? 'none')}`;
    }).join(', ');
    throw new Error(
      `Codex planner JSONL did not contain a final agent message (events: ${eventTypes || 'none'})`,
    );
  }
  return { output, toolCalls };
}

function isFailedToolEvent(event: Record<string, unknown>, item: Record<string, unknown>): boolean {
  const status = `${String(item.status ?? '')} ${String(event.type ?? '')}`.toLowerCase();
  const error = item.error;
  return status.includes('fail')
    || status.includes('error')
    || (error !== undefined && error !== null && error !== false && error !== '');
}

function extractText(value: Record<string, unknown>): string {
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map(part => isRecord(part) && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return { count: value.length };
    return value === undefined ? {} : { value: truncateText(String(value), 160) };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (/secret|token|key|content|conversation|prompt/i.test(key)) continue;
    if (typeof raw === 'string') summary[key] = truncateText(raw, 160);
    else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) summary[key] = raw;
    else if (Array.isArray(raw)) summary[key] = { count: raw.length };
    else if (isRecord(raw)) summary[key] = { keys: Object.keys(raw).slice(0, 8) };
  }
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
