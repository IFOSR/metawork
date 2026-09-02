import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import {
  resolveCurrentRuntimeHome,
  resolveRevisionRuntimeHome,
} from '../configuration/agent-runtime-renderer.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { RuntimeHomeMaterializer } from './runtime-home-materializer.js';
import type { ExecutorAffordanceId } from '../routing/types.js';
import type {
  HarnessDriver,
  HarnessLaunchInput,
  HarnessLaunchSpec,
  HarnessProbeResult,
  HarnessProgressEvent,
  HarnessProgressLineInput,
  HarnessResultStreamSnapshot,
  HarnessResultStreamTracker,
  HarnessResultInput,
  MaterializedRuntimeHome,
  ProbeCommandRunner,
  RuntimeHomeInput,
} from './harness-driver.js';
import {
  emptyToUndefined,
  normalizeHarnessResult,
  assistantMessageText,
  parseJsonLine,
  parseJsonLines,
  safeHostEnvironment,
  safeHarnessName,
} from './harness-driver.js';

const execFileAsync = promisify(execFile);
const MAX_PROVISIONAL_TEXT_BYTES = 1024 * 1024;

export class PiCliDriver implements HarnessDriver {
  readonly id = 'pi-cli';
  readonly executionProtocols = ['workspace-image-artifact-v1'] as const;
  readonly supportsResponseOnly = true;
  private readonly runProbe: ProbeCommandRunner;
  private readonly explicitHomeTemplateDir?: string;
  private readonly generatedRuntimeRoot?: string;
  private readonly fallbackHomeTemplateDir?: string;
  private readonly webExtensionSourcePath?: string;

  constructor(dependencies: {
    probeCommand?: ProbeCommandRunner;
    homeTemplateDir?: string;
    generatedRuntimeRoot?: string;
    webExtensionSourcePath?: string;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    this.explicitHomeTemplateDir = emptyToUndefined(dependencies.homeTemplateDir);
    this.generatedRuntimeRoot = emptyToUndefined(dependencies.generatedRuntimeRoot);
    this.webExtensionSourcePath = emptyToUndefined(
      dependencies.webExtensionSourcePath
        ?? process.env.METACLAW_PI_ATTEMPT_EXTENSION
        ?? join(resolveMetaWorkPaths().appCurrent, 'dist', 'pi-attempt-tools.ts'),
    );
    this.fallbackHomeTemplateDir = emptyToUndefined(
      resolveCurrentRuntimeHome(resolveMetaWorkPaths().generatedAgentRuntime, 'pi-home')
      ?? process.env.METACLAW_EXECUTOR_PI_HOME,
    );
  }

  async probe(): Promise<HarnessProbeResult> {
    const result = await this.runProbe('pi', ['--version']);
    return result.code === 0
      ? { available: true, detail: result.stdout.trim() }
      : { available: false, detail: result.stderr.trim() || `pi exited with ${result.code}` };
  }

  async materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome> {
    const materializer = new RuntimeHomeMaterializer(input.attemptsRoot);
    const { homePath } = materializer.resolvePaths(input.attemptId);
    const agentPath = `${homePath}/.pi/agent`;
    const sessionPath = `${agentPath}/sessions`;
    const home = await materializer.materialize({
      attemptId: input.attemptId,
      revisionId: input.revisionId,
      agentClassId: input.agentClassId,
      bindingFingerprint: input.bindingFingerprint,
      environment: {
        HOME: homePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: sessionPath,
        ...input.environment,
      },
      homeDirectories: ['.pi/agent/sessions'],
    });
    await this.seedProviderConfig(homePath, input.revisionId);
    await this.seedWebExtension(homePath, input.executorAffordances);
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    const agentPath = `${input.runtimeHomePath}/.pi/agent`;
    return {
      command: 'pi',
      args: [
        '--mode',
        'json',
        ...(input.responseOnly ? ['--no-session', '--tools', ''] : []),
        ...(input.providerRef && input.modelId
          ? ['--provider', input.providerRef, '--model', input.modelId]
          : []),
        input.prompt,
      ],
      cwd: input.cwd,
      environment: {
        HOME: input.runtimeHomePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: `${agentPath}/sessions`,
      },
    };
  }

  parseResult(input: HarnessResultInput) {
    const events = parseJsonLines(input.stdout);
    const terminalError = findPiTerminalError(events);
    if (terminalError) {
      return {
        success: false as const,
        output: input.streamedOutput?.trim() ?? lastAssistantMessageText(events) ?? '',
        error: redactSensitiveText(terminalError),
      };
    }
    if (input.exitCode === 0) {
      const streamedOutput = input.streamedOutput?.trim();
      if (streamedOutput) {
        return { success: true as const, output: streamedOutput };
      }
      const messages = events
        .filter(event => event.type === 'message_end')
        .map(event => assistantMessageText(event.message))
        .filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return { success: true as const, output: messages.at(-1)! };
      }
      return {
        success: false as const,
        output: '' as const,
        error: 'Pi executor exited without a final assistant response',
      };
    }
    return normalizeHarnessResult(input);
  }

  parseResultLine(input: HarnessProgressLineInput): string | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || !['message_end', 'turn_end'].includes(String(event.type))) return null;
    return assistantMessageText(event.message);
  }

  createResultStreamTracker(): HarnessResultStreamTracker {
    return new PiResultStreamTracker();
  }

  parseProgressLine(input: HarnessProgressLineInput): HarnessProgressEvent | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return null;
    if (event.type === 'agent_start') {
      return { kind: 'status', text: 'Executor agent loop started' };
    }
    if (event.type === 'turn_start') {
      const turn = typeof event.turnIndex === 'number' ? event.turnIndex + 1 : null;
      return {
        kind: 'status',
        text: turn ? `Executor processing cycle ${turn}` : 'Executor processing cycle started',
      };
    }
    if (event.type === 'message_start' && messageRole(event.message) === 'assistant') {
      return { kind: 'status', text: 'Executor model response stream started' };
    }
    if (event.type === 'message_end' && messageRole(event.message) === 'assistant') {
      // Executor 的执行叙述（assistant 正文）：脱敏截断后实时呈现给用户，
      // 让用户看到 Executor 正在做什么、想什么、下一步做什么。
      const text = assistantMessageText(event.message);
      if (text) {
        return { kind: 'status', text: `Executor: ${executorActivityExcerpt(text)}` };
      }
      return null;
    }
    if (event.type === 'tool_execution_start') {
      const detail = toolArgSummary(event.args);
      return {
        kind: 'skill',
        text: `Executor started tool: ${safeHarnessName(event.toolName)}${detail ? ` — ${detail}` : ''}`,
      };
    }
    if (event.type === 'tool_execution_end') {
      const detail = toolArgSummary(event.args);
      return {
        kind: 'skill',
        text: `Executor ${event.isError === true ? 'failed' : 'completed'} tool: ${safeHarnessName(event.toolName)}${detail ? ` — ${detail}` : ''}`,
      };
    }
    if (event.type === 'turn_end') {
      return { kind: 'status', text: 'Executor processing cycle completed' };
    }
    if (event.type === 'agent_end') {
      return { kind: 'status', text: 'Executor agent loop completed' };
    }
    if (event.type === 'agent_settled') {
      return { kind: 'status', text: 'Executor process settled' };
    }
    return null;
  }

  private async seedProviderConfig(homePath: string, revisionId: string): Promise<void> {
    const revisionHome = this.generatedRuntimeRoot
      ? resolveRevisionRuntimeHome(this.generatedRuntimeRoot, revisionId, 'pi-home')
      : undefined;
    if (this.generatedRuntimeRoot && !revisionHome) {
      throw new Error(
        `Pi executor runtime home is missing for configuration revision ${revisionId}: `
        + join(this.generatedRuntimeRoot, revisionId, 'pi-home'),
      );
    }
    const templateDir = this.explicitHomeTemplateDir
      ?? revisionHome
      ?? this.fallbackHomeTemplateDir;
    if (!templateDir) return;
    const sourceDir = join(templateDir, '.pi', 'agent');
    const targetDir = join(homePath, '.pi', 'agent');
    for (const fileName of ['models.json', 'settings.json']) {
      const source = join(sourceDir, fileName);
      if (!existsSync(source)) {
        throw new Error(`Pi executor home template is missing ${fileName}: ${source}`);
      }
      const target = join(targetDir, fileName);
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
  }

  private async seedWebExtension(
    homePath: string,
    affordances: readonly ExecutorAffordanceId[] | undefined,
  ): Promise<void> {
    if (!this.webExtensionSourcePath || !hasWebResearchAffordances(affordances)) return;
    const extensionsDir = join(homePath, '.pi', 'agent', 'extensions');
    await mkdir(extensionsDir, { recursive: true, mode: 0o700 });
    const target = join(extensionsDir, 'metawork-web-tools.ts');
    await copyFile(this.webExtensionSourcePath, target);
    await chmod(target, 0o600);
  }
}

class PiResultStreamTracker implements HarnessResultStreamTracker {
  private completedOutput: string | null = null;
  private provisionalOutput = '';
  private assistantStreamOpen = false;
  private lastEventKind: string | null = null;
  private turnIndex: number | null = null;

  observe(input: HarnessProgressLineInput): void {
    if (input.stream !== 'stdout') return;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return;
    this.lastEventKind = event.type;
    if (event.type === 'turn_start' && typeof event.turnIndex === 'number') {
      this.turnIndex = event.turnIndex;
      return;
    }
    if (event.type === 'message_start' && messageRole(event.message) === 'assistant') {
      this.assistantStreamOpen = true;
      this.provisionalOutput = '';
      return;
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== 'object' || Array.isArray(update)) return;
      const assistantEvent = update as Record<string, unknown>;
      if (assistantEvent.type !== 'text_delta' || typeof assistantEvent.delta !== 'string') return;
      this.lastEventKind = 'message_update:text_delta';
      this.assistantStreamOpen = true;
      this.provisionalOutput = appendBoundedUtf8(
        this.provisionalOutput,
        assistantEvent.delta,
        MAX_PROVISIONAL_TEXT_BYTES,
      );
      return;
    }
    if (
      (event.type === 'message_end' || event.type === 'turn_end')
      && messageRole(event.message) === 'assistant'
    ) {
      const output = assistantMessageText(event.message);
      if (output) this.completedOutput = output;
      this.provisionalOutput = '';
      this.assistantStreamOpen = false;
    }
  }

  snapshot(): HarnessResultStreamSnapshot {
    const provisional = this.assistantStreamOpen && this.provisionalOutput.length > 0;
    const output = provisional ? this.provisionalOutput : this.completedOutput;
    return {
      output,
      provisional,
      diagnostics: {
        lastEventKind: this.lastEventKind,
        turnIndex: this.turnIndex,
        assistantStreamOpen: this.assistantStreamOpen,
        safeTextBytes: Buffer.byteLength(output ?? '', 'utf8'),
      },
    };
  }
}

function appendBoundedUtf8(current: string, delta: string, maxBytes: number): string {
  const combined = current + delta;
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.length <= maxBytes) return combined;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function hasWebResearchAffordances(
  affordances: readonly ExecutorAffordanceId[] | undefined,
): boolean {
  const available = new Set(affordances ?? []);
  const requiredAffordances = [
    'public-web-search',
    'public-web-fetch',
    'source-citation',
  ] as const;
  return requiredAffordances.every(affordance => available.has(affordance));
}

function findPiTerminalError(events: Record<string, unknown>[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      const message = [...event.messages].reverse().find(isAssistantMessage);
      if (message) return assistantTerminalError(message);
    }
    if (['message_end', 'turn_end'].includes(String(event.type)) && isAssistantMessage(event.message)) {
      return assistantTerminalError(event.message);
    }
    if (
      event.type === 'error'
      && typeof event.errorMessage === 'string'
      && event.errorMessage.trim()
    ) {
      return event.errorMessage.trim();
    }
  }
  return null;
}

function lastAssistantMessageText(events: Record<string, unknown>[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const candidates = event.type === 'agent_end' && Array.isArray(event.messages)
      ? event.messages
      : [event.message];
    for (const candidate of [...candidates].reverse()) {
      const text = assistantMessageText(candidate);
      if (text) return text;
    }
  }
  return null;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).role === 'assistant';
}

function messageRole(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof (value as Record<string, unknown>).role === 'string'
    ? String((value as Record<string, unknown>).role)
    : null;
}

/** 工具参数中允许进入用户可见进度的白名单键；其余一律不透出。 */
const TOOL_ARG_KEYS = [
  'command',
  'path',
  'file_path',
  'url',
  'query',
  'pattern',
  'skill',
] as const;

function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return executorActivityExcerpt(value, 120);
    }
  }
  return '';
}

/** 脱敏 + 压缩空白 + 截断：Executor 活动文本进入用户可见进度的唯一通道。 */
export function executorActivityExcerpt(value: string, limit = 240): string {
  const normalized = redactSensitiveText(value.replace(/\s+/gu, ' ').trim());
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
}

function assistantTerminalError(message: Record<string, unknown>): string | null {
  const stopReason = typeof message.stopReason === 'string'
    ? message.stopReason.toLowerCase()
    : '';
  const errorMessage = typeof message.errorMessage === 'string'
    ? message.errorMessage.trim()
    : '';
  if (stopReason === 'error' || stopReason === 'aborted' || errorMessage) {
    return errorMessage || `Pi executor request ${stopReason || 'failed'}`;
  }
  return null;
}

async function defaultProbeCommand(command: string, args: readonly string[]) {
  try {
    const result = await execFileAsync(command, [...args], {
      env: safeHostEnvironment(process.env),
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}
