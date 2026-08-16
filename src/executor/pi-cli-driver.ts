import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  readProviderEnvFile,
  safeHostEnvironment,
} from './harness-driver.js';

const execFileAsync = promisify(execFile);

export class PiCliDriver implements HarnessDriver {
  readonly id = 'pi-cli';
  private readonly runProbe: ProbeCommandRunner;
  private readonly homeTemplateDir?: string;
  private readonly envFile?: string;

  constructor(dependencies: {
    probeCommand?: ProbeCommandRunner;
    homeTemplateDir?: string;
    envFile?: string;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    this.homeTemplateDir = emptyToUndefined(
      dependencies.homeTemplateDir ?? process.env.METACLAW_EXECUTOR_PI_HOME,
    );
    this.envFile = emptyToUndefined(
      dependencies.envFile ?? process.env.METACLAW_PI_EXECUTOR_ENV_FILE,
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
        ...readProviderEnvFile(this.envFile, 'Pi'),
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
      args: ['-p', input.prompt],
      cwd: input.cwd,
      environment: {
        HOME: input.runtimeHomePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: `${agentPath}/sessions`,
      },
    };
  }

  parseResult(input: HarnessResultInput) {
    return normalizeHarnessResult(input);
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
