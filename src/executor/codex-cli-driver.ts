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
  HarnessResultInput,
  MaterializedRuntimeHome,
  ProbeCommandRunner,
  RuntimeHomeInput,
} from './harness-driver.js';
import {
  emptyToUndefined,
  normalizeHarnessResult,
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
    this.homeTemplateDir = emptyToUndefined(
      dependencies.homeTemplateDir
        ?? process.env.METACLAW_EXECUTOR_CODEX_HOME
        ?? resolveCurrentRuntimeHome(resolveAnyFusionPaths().generatedAgentRuntime, 'codex'),
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
      args: buildCodexNonInteractiveArgs(input.prompt),
      cwd: input.cwd,
      environment: { CODEX_HOME: input.runtimeHomePath },
    };
  }

  parseResult(input: HarnessResultInput) {
    return normalizeHarnessResult(input);
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
