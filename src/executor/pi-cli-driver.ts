import { execFile } from 'node:child_process';
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
import { normalizeHarnessResult } from './harness-driver.js';

const execFileAsync = promisify(execFile);

export class PiCliDriver implements HarnessDriver {
  readonly id = 'pi-cli';
  private readonly runProbe: ProbeCommandRunner;
  private readonly materializer: RuntimeHomeMaterializer;

  constructor(dependencies: {
    probeCommand?: ProbeCommandRunner;
    materializer?: RuntimeHomeMaterializer;
  } = {}) {
    this.runProbe = dependencies.probeCommand ?? defaultProbeCommand;
    this.materializer = dependencies.materializer ?? new RuntimeHomeMaterializer('/tmp/anyfusion-attempts');
  }

  async probe(): Promise<HarnessProbeResult> {
    const result = await this.runProbe('pi', ['--version']);
    return result.code === 0
      ? { available: true, detail: result.stdout.trim() }
      : { available: false, detail: result.stderr.trim() || `pi exited with ${result.code}` };
  }

  async materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome> {
    const homePath = `${input.attemptRoot}/home`;
    const agentPath = `${homePath}/.pi/agent`;
    const sessionPath = `${agentPath}/sessions`;
    const home = await this.materializer.materialize({
      ...input,
      environment: {
        HOME: homePath,
        PI_CODING_AGENT_DIR: agentPath,
        PI_CODING_AGENT_SESSION_DIR: sessionPath,
      },
    });
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
}

async function defaultProbeCommand(command: string, args: readonly string[]) {
  try {
    const result = await execFileAsync(command, [...args], { env: {} });
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
