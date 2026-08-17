import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import { resolveCurrentRuntimeHome } from '../configuration/agent-runtime-renderer.js';
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
        ?? resolveCurrentRuntimeHome(resolveAnyFusionPaths().generatedAgentRuntime, 'pi-home')
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
    await this.seedProviderConfig(homePath);
    return home;
  }

  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec {
    const agentPath = `${input.runtimeHomePath}/.pi/agent`;
    return {
      command: 'pi',
      args: ['--mode', 'json', input.prompt],
      cwd: input.cwd,
      environment: {
        HOME: input.runtimeHomePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: `${agentPath}/sessions`,
      },
    };
  }

  parseResult(input: HarnessResultInput) {
    if (input.exitCode === 0) {
      const streamedOutput = input.streamedOutput?.trim();
      if (streamedOutput) {
        return { success: true as const, output: streamedOutput };
      }
      const messages = parseJsonLines(input.stdout)
        .filter(event => event.type === 'message_end')
        .map(event => assistantMessageText(event.message))
        .filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return { success: true as const, output: messages.at(-1)! };
      }
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
    if (event.type === 'agent_end') {
      return { kind: 'status', text: 'Executor agent loop completed' };
    }
    return null;
  }

  private async seedProviderConfig(homePath: string): Promise<void> {
    if (!this.homeTemplateDir) return;
    const sourceDir = join(this.homeTemplateDir, '.pi', 'agent');
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
