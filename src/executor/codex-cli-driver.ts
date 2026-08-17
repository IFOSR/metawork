import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import { resolveCurrentRuntimeHome } from '../configuration/agent-runtime-renderer.js';
import { buildCodexNonInteractiveArgs } from './codex-args.js';
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
  parseJsonLine,
  parseJsonLines,
  safeHostEnvironment,
} from './harness-driver.js';

const execFileAsync = promisify(execFile);

export class CodexCliDriver implements HarnessDriver {
  readonly id = 'codex-cli';
  private readonly runProbe: ProbeCommandRunner;
  private readonly homeTemplateDir?: string;

  constructor(dependencies: {
    probeCommand?: ProbeCommandRunner;
    homeTemplateDir?: string;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    // 优先级：显式依赖 > 当前 generated agent-runtime > legacy 环境变量。
    // generated agent-runtime 由配置激活时渲染并切换 current 指针，是 executor
    // 应使用的权威 home；legacy 环境变量仅作为未渲染时的兜底。
    this.homeTemplateDir = emptyToUndefined(
      dependencies.homeTemplateDir
        ?? resolveCurrentRuntimeHome(resolveAnyFusionPaths().generatedAgentRuntime, 'codex')
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
    await this.seedProviderConfig(homePath);
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    return {
      command: 'codex',
      // The attempt worktree is the trust boundary; codex still defaults to a
      // read-only sandbox for `exec`, so workspace writes must be explicit.
      args: buildCodexNonInteractiveArgs(input.prompt, { json: true }),
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
    const itemType = (item as Record<string, unknown>).type;
    const completed = event.type === 'item.completed';
    if (itemType === 'command_execution') {
      return {
        kind: 'status',
        text: completed
          ? 'Executor completed a workspace command'
          : 'Executor started a workspace command',
      };
    }
    if (itemType === 'mcp_tool_call') {
      return {
        kind: 'skill',
        text: completed ? 'Executor completed an MCP tool call' : 'Executor started an MCP tool call',
      };
    }
    if (itemType === 'web_search') {
      return {
        kind: 'skill',
        text: completed ? 'Executor completed a web search' : 'Executor started a web search',
      };
    }
    if (itemType === 'file_change' && completed) {
      return { kind: 'status', text: 'Executor recorded workspace changes' };
    }
    return null;
  }

  private async seedProviderConfig(homePath: string): Promise<void> {
    if (!this.homeTemplateDir) return;
    const source = join(this.homeTemplateDir, 'config.toml');
    if (!existsSync(source)) {
      throw new Error(`Codex executor home template is missing config.toml: ${source}`);
    }
    const target = join(homePath, 'config.toml');
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
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
