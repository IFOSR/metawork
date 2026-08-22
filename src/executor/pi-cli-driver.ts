import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import {
  resolveCurrentRuntimeHome,
  resolveRevisionRuntimeHome,
} from '../configuration/agent-runtime-renderer.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { RuntimeHomeMaterializer } from './runtime-home-materializer.js';
import type {
  HarnessDriver,
  HarnessLaunchInput,
  HarnessLaunchSpec,
  HarnessProbeResult,
  HarnessProgressEvent,
  HarnessProgressLineInput,
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

export class PiCliDriver implements HarnessDriver {
  readonly id = 'pi-cli';
  private readonly runProbe: ProbeCommandRunner;
  private readonly explicitHomeTemplateDir?: string;
  private readonly generatedRuntimeRoot?: string;
  private readonly fallbackHomeTemplateDir?: string;

  constructor(dependencies: {
    probeCommand?: ProbeCommandRunner;
    homeTemplateDir?: string;
    generatedRuntimeRoot?: string;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    this.explicitHomeTemplateDir = emptyToUndefined(dependencies.homeTemplateDir);
    this.generatedRuntimeRoot = emptyToUndefined(dependencies.generatedRuntimeRoot);
    this.fallbackHomeTemplateDir = emptyToUndefined(
      resolveCurrentRuntimeHome(resolveAnyFusionPaths().generatedAgentRuntime, 'pi-home')
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
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    const agentPath = `${input.runtimeHomePath}/.pi/agent`;
    return {
      command: 'pi',
      args: [
        '--mode',
        'json',
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
    if (event.type === 'tool_execution_start') {
      return {
        kind: 'skill',
        text: `Executor started tool: ${safeHarnessName(event.toolName)}`,
      };
    }
    if (event.type === 'tool_execution_end') {
      return {
        kind: 'skill',
        text: `Executor ${event.isError === true ? 'failed' : 'completed'} tool: ${safeHarnessName(event.toolName)}`,
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
