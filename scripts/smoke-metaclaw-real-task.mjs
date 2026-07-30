import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const artifactExpectedLine = 'MetaClaw real task smoke passed.';
export const plannerMemoryMarker = 'native-thread-memory-7f3c9a';
const scenarioNames = new Set(['planner-session', 'artifact', 'python-hello']);

export function readOption(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseExecutorCommand(value) {
  const command = String(value).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
    throw new Error(`Invalid smoke executor command: ${value}`);
  }
  return command;
}

export function parseScenario(value) {
  const scenario = String(value).trim();
  if (!scenarioNames.has(scenario)) {
    throw new Error(`Invalid smoke scenario: ${value}. Expected one of: ${[...scenarioNames].join(', ')}`);
  }
  return scenario;
}

export function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

export function installPiConfig(input = {}) {
  const repoRoot = input.repoRoot ?? process.cwd();
  const targetHome = input.targetHome ?? homedir();
  const sourceDir = input.sourceDir ?? join(repoRoot, 'docker', 'pi-config');
  const targetDir = join(targetHome, '.pi', 'agent');

  for (const fileName of ['models.json', 'settings.json']) {
    const source = join(sourceDir, fileName);
    if (!existsSync(source)) {
      throw new Error(`Missing Pi smoke config file: ${source}`);
    }
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(sourceDir, 'models.json'), join(targetDir, 'models.json'));
  copyFileSync(join(sourceDir, 'settings.json'), join(targetDir, 'settings.json'));
  return targetDir;
}

export function bootstrapExecutor(input) {
  if (input.executorCommand !== 'pi') {
    return null;
  }

  return installPiConfig({
    repoRoot: input.repoRoot,
    targetHome: input.executorHome,
  });
}

export function buildScenarioScript(scenario) {
  if (scenario === 'planner-session') {
    return [
      `请记住本次会话测试口令是 ${plannerMemoryMarker}。只回复“已记住”，不要创建任务。`,
      '刚才的测试口令是什么？只回复口令，不要查询任务或创建任务。',
      '/exit',
      '',
    ].join('\n');
  }

  if (scenario === 'artifact') {
    return [
      `Create a file named smoke-result.md inside MetaClaw's managed Task workspace. The Runtime will provide the exact authorized target directory to the Executor, so do not ask me for a path. Its content must include this exact line: ${artifactExpectedLine} After creating it, tell me the absolute file path.`,
      '/exit',
      '',
    ].join('\n');
  }

  return [
    "Create a Python file named hello_world.py inside MetaClaw's managed Task workspace. The Runtime will provide the exact authorized target directory to the Executor, so do not ask me for a path.",
    'The Python file content must include exactly this line: print("hello world")',
    'Run the file with python3 and report the stdout.',
    '/exit',
    '',
  ].join('\n');
}

export function extractArtifactPath(output) {
  const markdownLink = output.match(/\[[^\]]*smoke-result\.md\]\(([^)]+smoke-result\.md)\)/);
  if (markdownLink?.[1]) {
    return markdownLink[1].trim();
  }
  const inlineCode = output.match(/`([^`\n]+smoke-result\.md)`/);
  if (inlineCode?.[1]) {
    return inlineCode[1].trim();
  }
  const match = output.match(/-\s+([^\n]+smoke-result\.md)/);
  return match?.[1]?.trim() ?? null;
}

export function findPythonHelloFile(workdir) {
  const candidates = findFiles(workdir, filePath => filePath.endsWith('.py'));
  return candidates.find(filePath => {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes('print("hello world")');
  }) ?? null;
}

export function findPythonCommand() {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (result.status === 0) {
      return command;
    }
  }

  throw new Error('Smoke failed: neither python3 nor python is available for independent verification');
}

export function verifyArtifactScenario(input) {
  const artifactPath = extractArtifactPath(input.output);
  if (!artifactPath) {
    throw new Error([
      'Smoke failed: MetaClaw output did not include smoke-result.md artifact path.',
      'Captured MetaClaw output:',
      String(input.output).slice(-4000),
    ].join('\n'));
  }

  if (!existsSync(artifactPath)) {
    throw new Error(`Smoke failed: artifact path does not exist: ${artifactPath}`);
  }

  const content = readFileSync(artifactPath, 'utf-8');
  if (!content.includes(artifactExpectedLine)) {
    throw new Error(`Smoke failed: artifact content does not include "${artifactExpectedLine}"`);
  }

  if (/Task Memory Cards/.test(input.output) || /娴犺濮熺拋鏉跨箓閸楋紕澧栭敍鍦盿sk Memory Cards/.test(input.output)) {
    throw new Error('Smoke failed: current task was recalled as task memory during its first execution');
  }

  if (/Summary:\s*Created file:\s*``/.test(input.output) || /閹芥顩?\s*瀹告彃鍨卞鐑樻瀮娴犺绱癭`/.test(input.output)) {
    throw new Error('Smoke failed: task summary used an empty quoted artifact path');
  }

  return { artifactPath };
}

export function verifyPythonHelloScenario(input) {
  const pythonFile = findPythonHelloFile(input.workdir);
  if (!pythonFile) {
    throw new Error('Smoke failed: no Python file containing print("hello world") was found in the workdir');
  }

  const pythonCommand = findPythonCommand();
  const result = spawnSync(pythonCommand, [pythonFile], {
    cwd: input.workdir,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Smoke failed: independent Python run failed with exit code ${result.status}: ${result.stderr ?? ''}`);
  }

  if ((result.stdout ?? '').trim() !== 'hello world') {
    throw new Error(`Smoke failed: independent Python stdout was "${(result.stdout ?? '').trim()}"`);
  }

  return { artifactPath: pythonFile, pythonCommand };
}

export function verifyPlannerSessionScenario(input) {
  if (input.sessionFiles.length !== 1) {
    throw new Error(
      `Smoke failed: expected exactly one native Codex session file for two turns, found ${input.sessionFiles.length}`,
    );
  }
  const recall = input.interactions.find(row => String(row.userInput ?? '').includes('刚才的测试口令是什么'));
  if (!recall || !String(recall.systemOutput ?? '').includes(plannerMemoryMarker)) {
    throw new Error('Smoke failed: the second Planner reply did not recall the marker from its native Codex session');
  }
  return { nativeSessionPath: input.sessionFiles[0] };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    shell: options.shell ?? false,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return result;
}

function readPlannerDiagnostics(repoRoot, metaclawHome) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) return '';
  const source = [
    "import Database from 'better-sqlite3';",
    "const db = new Database(process.argv[1], { readonly: true });",
    "const rows = db.prepare('SELECT status, attempt_count, error_summary FROM planner_runs ORDER BY created_at DESC LIMIT 3').all();",
    "const decisions = db.prepare('SELECT event_type, action, reason FROM kernel_decisions ORDER BY created_at DESC LIMIT 5').all();",
    "const attempts = db.prepare('SELECT terminal_state, error_code, error_detail, failure_json, substr(raw_response, 1, 1000) AS response FROM executor_attempt_receipts ORDER BY completed_at DESC LIMIT 3').all();",
    "const sandboxes = db.prepare('SELECT status, exit_code, cleanup_status, cleanup_error FROM attempt_sandboxes ORDER BY created_at DESC LIMIT 3').all();",
    'process.stdout.write(JSON.stringify({ plannerRuns: rows, decisions, attempts, sandboxes }));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, dbPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

function readPlannerInteractions(repoRoot, metaclawHome) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  const source = [
    "import Database from 'better-sqlite3';",
    "const db = new Database(process.argv[1], { readonly: true });",
    "const rows = db.prepare('SELECT user_input AS userInput, system_output AS systemOutput FROM interactions ORDER BY created_at ASC').all();",
    'process.stdout.write(JSON.stringify(rows));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, dbPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Smoke failed: could not read Planner interaction evidence: ${result.stderr ?? ''}`);
  }
  return JSON.parse(String(result.stdout ?? '[]'));
}

export function runSmoke(rawArgs = process.argv.slice(2), env = process.env) {
  if (env.METACLAW_SMOKE_IN_DOCKER !== 'true') {
    runDockerSmoke(rawArgs, env);
    return;
  }
  const repoRoot = resolve(process.cwd());
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }

  const executorCommand = parseExecutorCommand(
    readOption(rawArgs, '--executor') ?? env.METACLAW_SMOKE_EXECUTOR ?? 'codex',
  );
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const executorTimeout = parsePositiveInteger(
    readOption(rawArgs, '--timeout') ?? env.METACLAW_SMOKE_TIMEOUT,
    executorCommand === 'pi' ? 900 : 120,
  );
  const executorMaxDuration = parsePositiveInteger(
    readOption(rawArgs, '--max-duration') ?? env.METACLAW_SMOKE_MAX_DURATION,
    executorCommand === 'pi' ? 3600 : 300,
  );

  const smokeRoot = env.METACLAW_SMOKE_ROOT ? resolve(env.METACLAW_SMOKE_ROOT) : tmpdir();
  mkdirSync(smokeRoot, { recursive: true });
  const metaclawHome = mkdtempSync(join(smokeRoot, 'metaclaw-smoke-home-'));
  const executorHome = mkdtempSync(join(smokeRoot, 'metaclaw-smoke-executor-home-'));
  const workdir = mkdtempSync(join(smokeRoot, 'metaclaw-smoke-work-'));
  const scriptDir = mkdtempSync(join(smokeRoot, 'metaclaw-smoke-script-'));
  const scriptPath = join(scriptDir, 'script.txt');

  try {
    writeFileSync(join(metaclawHome, 'config.yaml'), [
      'version: 1',
      'executor:',
      `  command: ${executorCommand}`,
      `  timeout: ${executorTimeout}`,
      `  max_duration: ${executorMaxDuration}`,
      'orchestration:',
      '  reminder_enabled: false',
      '  reminder_throttle: 300',
      '  top_k_preferences: 5',
      '  blocked_recheck_enabled: false',
      'ui:',
      '  language: zh-CN',
      '  dashboard_on_start: false',
      'integrations:',
      '  markdown_preview:',
      '    enabled: false',
      'notifications:',
      '  feishu:',
      '    enabled: false',
      '',
    ].join('\n'));

    bootstrapExecutor({ executorCommand, executorHome, repoRoot });
    writeFileSync(scriptPath, buildScenarioScript(scenario));

    if (env.METACLAW_SMOKE_SKIP_BUILD !== 'true') {
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
    }
    const childEnv = {
      METACLAW_HOME: metaclawHome,
      METACLAW_PLANNER_SCHEMA_PATH: join(repoRoot, 'dist', 'planning-agent-plan-v6.schema.json'),
    };
    if (executorCommand === 'pi') {
      childEnv.HOME = executorHome;
      childEnv.USERPROFILE = executorHome;
    }

    const runResult = run('node', [join(repoRoot, 'dist/index.js'), '--script', scriptPath], {
      cwd: workdir,
      env: childEnv,
    });

    const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
    if (executorCommand === 'pi' && !output.includes('pi-agent')) {
      process.stderr.write(output);
      throw new Error('Smoke failed: expected route/execution output to mention pi-agent');
    }

    const verification = scenario === 'planner-session'
      ? verifyPlannerSessionScenario({
        interactions: readPlannerInteractions(repoRoot, metaclawHome),
        sessionFiles: findFiles(
          join(env.METACLAW_PLANNER_CODEX_HOME, 'sessions'),
          filePath => filePath.endsWith('.jsonl'),
        ),
      })
      : scenario === 'artifact'
        ? verifyArtifactScenario({ output, workdir })
        : verifyPythonHelloScenario({ output, workdir });

    process.stdout.write([
      scenario === 'planner-session'
        ? 'MetaClaw native Planner session smoke passed.'
        : 'MetaClaw real task smoke passed.',
      `Executor: ${executorCommand}`,
      `Scenario: ${scenario}`,
      scenario === 'planner-session'
        ? `Native session: ${verification.nativeSessionPath}`
        : `Artifact: ${verification.artifactPath}`,
      `Workdir: ${workdir}`,
      '',
    ].join('\n'));
  } catch (error) {
    const plannerDiagnostics = readPlannerDiagnostics(repoRoot, metaclawHome);
    if (plannerDiagnostics) process.stderr.write(`Planner diagnostics: ${plannerDiagnostics}\n`);
    throw error;
  } finally {
    rmSync(metaclawHome, { recursive: true, force: true });
    rmSync(executorHome, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

function runDockerSmoke(rawArgs, env) {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }
  const repoRoot = resolve(process.cwd());
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const plannerOnly = scenario === 'planner-session';
  const smokeRoot = mkdtempSync(join(tmpdir(), 'metaclaw-docker-smoke-'));
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `metaclaw-smoke-${suffix}`;
  const control = `metaclaw-smoke-control-${suffix}`;
  const runtimeImage = 'metaclaw-runtime:phase5';
  const mounts = [
    ['docker/planner-codex.env', '/run/metaclaw/env/planner-codex.env'],
    ['docker/executor-codex.env', '/run/metaclaw/env/executor-codex.env'],
    ['docker/executor-pi.env', '/run/metaclaw/env/executor-pi.env'],
  ];
  for (const [hostPath] of mounts) {
    if (!existsSync(join(repoRoot, hostPath))) {
      throw new Error(`Smoke requires ${hostPath}; copy the corresponding .env.example and configure the provider.`);
    }
  }

  try {
    run('docker', ['build', '-f', 'docker/Dockerfile.runtime', '-t', runtimeImage, '.'], { cwd: repoRoot });
    if (!plannerOnly) {
      run('docker', ['build', '-f', 'docker/Dockerfile.attempt-codex', '-t', 'metaclaw-executor-codex:phase5', '.'], { cwd: repoRoot });
      run('docker', ['build', '-f', 'docker/Dockerfile.attempt-pi', '-t', 'metaclaw-executor-pi:phase5', '.'], { cwd: repoRoot });
      run('docker', ['network', 'create', '--internal', network], { cwd: repoRoot });
    }
    const createArgs = [
      'create', '--name', control, '--network', 'bridge',
      '--workdir', '/app',
      '--mount', `type=bind,src=${smokeRoot},dst=/smoke`,
      ...(!plannerOnly ? [
        '--mount', 'type=bind,src=//var/run/docker.sock,dst=/var/run/docker.sock',
      ] : []),
      ...mounts.flatMap(([hostPath, containerPath]) => [
        '--mount', `type=bind,src=${join(repoRoot, hostPath)},dst=${containerPath},readonly`,
      ]),
      '-e', 'METACLAW_SMOKE_IN_DOCKER=true',
      '-e', 'METACLAW_SMOKE_SKIP_BUILD=true',
      '-e', 'METACLAW_SMOKE_ROOT=/smoke',
      ...(!plannerOnly ? [
        '-e', `METACLAW_CONTROL_NETWORK=${network}`,
        '-e', `METACLAW_DOCKER_HOST_PATH_MAP=${JSON.stringify({ '/smoke': smokeRoot })}`,
        '-e', 'METACLAW_CONTROL_HOST=metaclaw-control',
      ] : []),
      runtimeImage,
      'node', '/app/scripts/smoke-metaclaw-real-task.mjs',
      ...rawArgs,
    ];
    run('docker', createArgs, { cwd: repoRoot });
    if (!plannerOnly) {
      run('docker', ['network', 'connect', '--alias', 'metaclaw-control', network, control], { cwd: repoRoot });
    }
    const result = run('docker', ['start', '--attach', control], { cwd: repoRoot });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  } finally {
    spawnSync('docker', ['rm', '-f', control], { cwd: repoRoot, encoding: 'utf8' });
    if (!plannerOnly) {
      spawnSync('docker', ['network', 'rm', network], { cwd: repoRoot, encoding: 'utf8' });
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function buildHelp() {
  return [
    'Usage: npm run smoke:metaclaw -- [--executor <command>] [--scenario <planner-session|artifact|python-hello>] [--timeout <seconds>] [--max-duration <seconds>]',
    '',
    'Environment variables:',
    '  METACLAW_SMOKE_EXECUTOR      Executor command to place in the isolated config. Defaults to codex.',
    '  METACLAW_SMOKE_SCENARIO      Scenario to run. Defaults to planner-session (two-turn native Codex memory).',
    '  METACLAW_SMOKE_TIMEOUT       Continuous no-output timeout in seconds.',
    '  METACLAW_SMOKE_MAX_DURATION  Legacy max_duration value in seconds.',
    '  METACLAW_SMOKE_IN_DOCKER      Internal recursion guard; ordinary smoke runs create the control container automatically.',
    '',
    'Examples:',
    '  npm run smoke:metaclaw',
    '  npm run smoke:metaclaw -- --executor pi --scenario python-hello',
    '  METACLAW_SMOKE_EXECUTOR=pi METACLAW_SMOKE_SCENARIO=python-hello npm run smoke:metaclaw',
    '',
  ].join('\n');
}

function findFiles(root, predicate) {
  const results = [];
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      results.push(...findFiles(entryPath, predicate));
      continue;
    }

    if (stats.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSmoke();
}
