import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvFromFile } from '../utils/env-file.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { truncateText } from '../utils/truncate-text.js';
import { getPlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';
import type { PlanningContext } from './planning-types.js';

const MAX_RPC_LINE_BYTES = 1024 * 1024;

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
  threadId: string | null;
  durationMs: number;
}

export interface PlannerRunner {
  run(prompt: string, context: PlanningContext): Promise<PlannerRunResult>;
}

type SpawnFn = typeof spawn;

export interface PlannerProcessRunnerDeps {
  command?: string;
  spawn?: SpawnFn;
  plannerHome?: string;
  cwd?: string;
  envFile?: string;
  sessionDir?: string;
  args?: string[];
}

/**
 * Controlled-lifecycle JSONL RPC adapter for non-interactive Planner surfaces.
 * Each run owns one Pi process and one session writer. Runs targeting the same
 * session are serialized so Gateway/Feishu cannot corrupt the Pi session file.
 */
export class PlannerProcessRunner implements PlannerRunner {
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: PlannerProcessRunnerDeps = {}) {}

  async run(prompt: string, context: PlanningContext): Promise<PlannerRunResult> {
    const sessionId = context.request.sessionId;
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sessionQueues.set(sessionId, tail);
    await previous.catch(() => undefined);

    try {
      return await this.runRpc(prompt, context);
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === tail) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async runRpc(prompt: string, context: PlanningContext): Promise<PlannerRunResult> {
    const startedAt = Date.now();
    const command = this.deps.command
      ?? process.env.METACLAW_PLANNER_COMMAND
      ?? process.env.METACLAW_PLANNER_TUI_COMMAND
      ?? 'anyfusion-planner';
    const cwd = this.deps.cwd ?? process.env.METACLAW_PLANNER_WORKDIR ?? tmpdir();
    const plannerHome = this.deps.plannerHome
      ?? process.env.METACLAW_PLANNER_HOME
      ?? process.env.ANYFUSION_PLANNER_HOME
      ?? join(process.env.METACLAW_HOME ?? tmpdir(), 'anyfusion-planner');
    const sessionDir = this.deps.sessionDir
      ?? process.env.METACLAW_PLANNER_SESSION_DIR
      ?? join(plannerHome, 'sessions');
    const sessionPath = join(sessionDir, `${context.request.sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });

    const args = this.deps.args
      ?? parsePlannerArgs(process.env.METACLAW_PLANNER_ARGS)
      ?? [
        '--mode', 'rpc',
        '--offline',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--session', sessionPath,
      ];
    const env = buildEnvFromFile(this.deps.envFile ?? process.env.METACLAW_PLANNER_ENV_FILE);
    const requestId = `planner-${context.request.sessionId}-${startedAt}`;

    return new Promise((resolve, reject) => {
      const proc = (this.deps.spawn ?? spawn)(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...env,
          ANYFUSION_PLANNER_MODE: '1',
          ANYFUSION_PLANNER_HOME: plannerHome,
          ANYFUSION_PLANNER_SESSION_DIR: sessionDir,
          ANYFUSION_PLANNER_SESSION_ID: context.request.sessionId,
          ANYFUSION_PLANNER_REQUEST_SOURCE: context.request.source,
          ANYFUSION_PLANNER_SCHEMA_PATH: process.env.ANYFUSION_PLANNER_SCHEMA_PATH
            ?? process.env.METACLAW_PLANNER_SCHEMA_PATH,
          ANYFUSION_PLANNER_CATALOG_JSON: JSON.stringify(getPlannerExecutorCatalog()),
        },
      });
      let stdoutBuffer = '';
      let stderr = '';
      let settled = false;
      let promptAccepted = false;
      let pendingResult: PlannerRunResult | null = null;
      const toolCalls: PlannerToolCallTrace[] = [];
      const toolStarts = new Map<string, Record<string, unknown>>();

      const timer = setTimeout(() => {
        fail(new Error(`AnyFusion Planner RPC timed out after ${context.timeoutMs}ms`));
      }, context.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        proc.kill('SIGTERM');
        reject(error);
      };
      const acceptLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) throw new Error('event must be an object');
          event = parsed;
        } catch (error) {
          fail(new Error(`AnyFusion Planner RPC emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (event.type === 'response' && event.id === requestId && event.command === 'prompt') {
          if (event.success !== true) {
            fail(new Error(`AnyFusion Planner rejected the prompt: ${truncateText(redactSensitiveText(String(event.error ?? "unknown error")), 500)}`));
            return;
          }
          promptAccepted = true;
          return;
        }
        if (event.type === 'tool_execution_start') {
          const toolCallId = String(event.toolCallId ?? toolStarts.size + 1);
          toolStarts.set(toolCallId, event);
          return;
        }
        if (event.type === 'tool_execution_end') {
          const toolCallId = String(event.toolCallId ?? toolCalls.length + 1);
          const start = toolStarts.get(toolCallId);
          toolCalls.push({
            sequence: toolCalls.length + 1,
            toolName: String(event.toolName ?? start?.toolName ?? 'unknown'),
            status: event.isError === true ? 'failed' : 'completed',
            argumentsSummary: summarizeValue(start?.args),
            resultSummary: summarizeValue(event.result),
          });
          return;
        }
        if (event.type === 'agent_end') {
          const output = extractLastAssistantText(event.messages);
          if (!output) {
            fail(new Error('AnyFusion Planner RPC completed without a final assistant message'));
            return;
          }
          pendingResult = {
            output,
            toolCalls,
            threadId: sessionPath,
            durationMs: Date.now() - startedAt,
          };
          proc.stdin?.end();
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBuffer += chunk.toString();
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0 && !settled) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
          if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
            fail(new Error(`AnyFusion Planner RPC exceeded the ${MAX_RPC_LINE_BYTES}-byte JSONL limit`));
            return;
          }
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          acceptLine(line);
          newline = stdoutBuffer.indexOf('\n');
        }
        if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_RPC_LINE_BYTES) {
          fail(new Error(`AnyFusion Planner RPC exceeded the ${MAX_RPC_LINE_BYTES}-byte JSONL limit`));
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (error) => fail(error));
      proc.on('close', (code, signal) => {
        if (settled) return;
        if (stdoutBuffer.trim()) acceptLine(stdoutBuffer.replace(/\r$/u, ''));
        if (settled) return;
        if (code !== 0) {
          fail(new Error(
            `AnyFusion Planner RPC exited with ${code ?? 'unknown'} (${signal ?? 'no signal'}): ${truncateText(redactSensitiveText(stderr), 500)}`,
          ));
          return;
        }
        if (!promptAccepted) {
          fail(new Error('AnyFusion Planner RPC exited before accepting the prompt'));
          return;
        }
        if (!pendingResult) {
          fail(new Error('AnyFusion Planner RPC exited before completing the turn'));
          return;
        }
        settled = true;
        cleanup();
        resolve(pendingResult);
      });

      proc.stdin?.on('error', error => fail(error));
      proc.stdin?.write(`${JSON.stringify({ id: requestId, type: 'prompt', message: prompt })}\n`);
    });
  }
}

function parsePlannerArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('METACLAW_PLANNER_ARGS must be a JSON string array');
  }
  return parsed;
}

function extractLastAssistantText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const message of [...value].reverse()) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = message.content
      .map(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
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
    if (/secret|token|key|content|conversation|prompt/iu.test(key)) continue;
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
