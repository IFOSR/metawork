import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import {
  resolveCurrentRuntimeHome,
  resolveRevisionRuntimeHome,
} from '../configuration/agent-runtime-renderer.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';
import { RuntimeHomeMaterializer } from './runtime-home-materializer.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
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
  parseJsonLine,
  parseJsonLines,
  safeHarnessName,
  safeHostEnvironment,
} from './harness-driver.js';
import { executorActivityExcerpt } from './pi-cli-driver.js';

const execFileAsync = promisify(execFile);

export class CodexCliDriver implements HarnessDriver {
  readonly id = 'codex-cli';
  readonly supportsResponseOnly = true;
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
      resolveCurrentRuntimeHome(resolveMetaWorkPaths().generatedAgentRuntime, 'codex')
      ?? process.env.METACLAW_EXECUTOR_CODEX_HOME,
    );
  }

  async probe(): Promise<HarnessProbeResult> {
    const result = await this.runProbe('codex', ['--version']);
    return result.code === 0
      ? { available: true, detail: result.stdout.trim() }
      : { available: false, detail: result.stderr.trim() || `codex exited with ${result.code}` };
  }

  async materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome> {
    const materializer = new RuntimeHomeMaterializer(input.attemptsRoot);
    const { homePath } = materializer.resolvePaths(input.attemptId);
    const home = await materializer.materialize({
      attemptId: input.attemptId,
      revisionId: input.revisionId,
      agentClassId: input.agentClassId,
      bindingFingerprint: input.bindingFingerprint,
      environment: {
        CODEX_HOME: homePath,
        ...input.environment,
      },
    });
    await this.seedProviderConfig(homePath, input.revisionId);
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    return {
      command: 'codex',
      // The attempt worktree is the trust boundary; codex still defaults to a
      // read-only sandbox for `exec`, so workspace writes must be explicit.
      args: buildCodexNonInteractiveArgs(input.prompt, {
        json: true,
        sandbox: input.responseOnly ? 'read-only' : 'workspace-write',
        ...(input.providerRef && input.modelId
          ? { providerRef: input.providerRef, modelId: input.modelId }
          : {}),
      }),
      cwd: input.cwd,
      environment: { CODEX_HOME: input.runtimeHomePath },
    };
  }

  parseResult(input: HarnessResultInput) {
    if (input.exitCode === 0) {
      const streamedOutput = input.streamedOutput?.trim();
      if (streamedOutput) {
        return { success: true as const, output: streamedOutput };
      }
      const messages = parseJsonLines(input.stdout)
        .filter(event => event.type === 'item.completed')
        .map(event => event.item)
        .filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        ))
        .filter(item => item.type === 'agent_message' && typeof item.text === 'string')
        .map(item => String(item.text).trim())
        .filter(Boolean);
      if (messages.length > 0) {
        return { success: true as const, output: messages.at(-1)! };
      }
    }
    return normalizeHarnessResult(input);
  }

  parseResultLine(input: HarnessProgressLineInput): string | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || event.type !== 'item.completed') return null;
    const item = event.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (record.type !== 'agent_message' || typeof record.text !== 'string') return null;
    return record.text.trim() || null;
  }

  parseProgressLine(input: HarnessProgressLineInput): HarnessProgressEvent | null {
    if (input.stream !== 'stdout') return null;
    const event = parseJsonLine(input.line);
    if (!event || typeof event.type !== 'string') return null;
    if (event.type === 'thread.started') {
      return { kind: 'status', text: 'Executor session started' };
    }
    if (event.type === 'turn.started') {
      return { kind: 'status', text: 'Executor processing cycle started' };
    }
    if (!['item.started', 'item.completed'].includes(event.type)) return null;
    const item = event.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const itemType = record.type;
    const completed = event.type === 'item.completed';
    if (itemType === 'command_execution') {
      const command = typeof record.command === 'string'
        ? executorActivityExcerpt(record.command, 120)
        : '';
      return {
        kind: 'status',
        text: completed
          ? `Executor completed workspace command${command ? `: ${command}` : ''}`
          : `Executor started workspace command${command ? `: ${command}` : ''}`,
      };
    }
    if (itemType === 'mcp_tool_call') {
      const tool = typeof record.tool === 'string'
        ? safeHarnessName(record.tool)
        : typeof record.name === 'string'
          ? safeHarnessName(record.name)
          : '';
      const detail = codexArgDetail(record.arguments ?? record.args);
      return {
        kind: 'skill',
        text: `${completed ? 'Executor completed' : 'Executor started'} MCP tool${tool ? `: ${tool}` : ''}${detail ? ` — ${detail}` : ''}`,
      };
    }
    if (itemType === 'web_search') {
      const query = typeof record.query === 'string'
        ? executorActivityExcerpt(record.query, 120)
        : '';
      return {
        kind: 'skill',
        text: `${completed ? 'Executor completed' : 'Executor started'} web search${query ? `: ${query}` : ''}`,
      };
    }
    if (itemType === 'agent_message' && completed) {
      const text = typeof record.text === 'string' && record.text.trim()
        ? executorActivityExcerpt(record.text)
        : '';
      if (text) return { kind: 'status', text: `Executor: ${text}` };
      return { kind: 'status', text: 'Executor produced an assistant message' };
    }
    if (itemType === 'reasoning') {
      // 隐藏思维链内容不透出，只呈现"正在推理"这一安全里程碑。
      return {
        kind: 'status',
        text: completed
          ? 'Executor finished a reasoning step'
          : 'Executor is reasoning through the next step',
      };
    }
    if (itemType === 'file_change' && completed) {
      return { kind: 'status', text: 'Executor recorded workspace changes' };
    }
    return null;
  }

  private async seedProviderConfig(homePath: string, revisionId: string): Promise<void> {
    const revisionHome = this.generatedRuntimeRoot
      ? resolveRevisionRuntimeHome(this.generatedRuntimeRoot, revisionId, 'codex')
      : undefined;
    if (this.generatedRuntimeRoot && !revisionHome) {
      throw new Error(
        `Codex executor runtime home is missing for configuration revision ${revisionId}: `
        + join(this.generatedRuntimeRoot, revisionId, 'codex'),
      );
    }
    const templateDir = this.explicitHomeTemplateDir
      ?? revisionHome
      ?? this.fallbackHomeTemplateDir;
    if (!templateDir) return;
    const source = join(templateDir, 'config.toml');
    if (!existsSync(source)) {
      throw new Error(`Codex executor home template is missing config.toml: ${source}`);
    }
    const target = join(homePath, 'config.toml');
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
}

/** Codex 工具调用参数的安全摘要：只取白名单键，脱敏截断。 */
function codexArgDetail(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return redactSensitiveText(value.replace(/\s+/gu, ' ').trim()).slice(0, 120);
    }
  }
  return '';
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
