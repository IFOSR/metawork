import {
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
import Database from 'better-sqlite3';
import { dump, load } from 'js-yaml';

const artifactExpectedLine = 'MetaClaw real task smoke passed.';
const pythonHelloFileName = 'hello.py';
const pythonHelloSource = 'print("Hello world")';
const pythonHelloOutput = 'Hello world';
export const plannerMemoryMarker = 'planner-memory-sunrise';
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

export function buildScenarioScript(scenario) {
  if (scenario === 'planner-session') {
    return [
      `请记住本次会话测试短语是 ${plannerMemoryMarker}。只回复“已记住”，不要创建任务。`,
      '刚才的测试短语是什么？只回复短语，不要查询任务或创建任务。',
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
    `请在当前工作区新建 ${pythonHelloFileName}，内容严格为一行 ${pythonHelloSource}。使用 python3 运行该文件，并确认标准输出严格为 ${pythonHelloOutput}。`,
    '/exit',
    '',
  ].join('\n');
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

export function resolveSmokeAccountPaths(installRoot) {
  const accountRoot = join(resolve(installRoot), 'accounts', 'local-default');
  return {
    accountRoot,
    database: join(accountRoot, 'data', 'anyfusion.db'),
    plannerSessions: join(accountRoot, 'planner', 'sessions'),
  };
}

export function readAuthoritativeTaskState(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`Smoke failed: authoritative database does not exist: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      acceptedProposalCount: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM planner_proposal_submissions
        WHERE status = 'accepted'
      `).get().count),
      tasks: db.prepare(`
        SELECT id, status, title, artifacts_json AS artifactsJson
        FROM tasks
        ORDER BY created_at, id
      `).all(),
      subtasks: db.prepare(`
        SELECT id, task_id AS taskId, status, error, artifacts_json AS artifactsJson
        FROM subtasks
        ORDER BY created_at, id
      `).all(),
      receipts: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               terminal_state AS terminalState, error_code AS errorCode,
               error_detail AS errorDetail, completed_at AS completedAt
        FROM executor_attempt_receipts
        ORDER BY completed_at DESC, attempt_id
      `).all(),
      publications: db.prepare(`
        SELECT id, task_id AS taskId, subtask_id AS subtaskId, status,
               error_summary AS errorSummary
        FROM workspace_publications
        ORDER BY created_at, id
      `).all(),
      dispatchItems: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               status, error_summary AS errorSummary
        FROM kernel_dispatch_items
        ORDER BY created_at, attempt_id
      `).all(),
    };
  } finally {
    db.close();
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatAuthoritativeFailure(state) {
  return JSON.stringify({
    acceptedProposalCount: state.acceptedProposalCount,
    tasks: state.tasks,
    subtasks: state.subtasks,
    receipts: state.receipts,
    publications: state.publications,
    dispatchItems: state.dispatchItems,
  });
}

export function buildSmokeConfig(input) {
  const templatePath = input.templatePath ?? join(input.repoRoot, 'docker', 'tui-config.yaml');
  if (!existsSync(templatePath)) {
    throw new Error(`Smoke failed: shell config template does not exist: ${templatePath}`);
  }
  const config = load(readFileSync(templatePath, 'utf-8'));
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`Smoke failed: invalid shell config template: ${templatePath}`);
  }
  config.executor = {
    ...(typeof config.executor === 'object' && config.executor !== null
      ? config.executor
      : {}),
    command: input.executorCommand,
    timeout: input.executorTimeout,
    max_duration: input.executorMaxDuration,
  };
  // These legacy presentation/integration fields intentionally have no schema-v2
  // mapping. Smoke exercises Runtime behavior and uses the schema-v2 defaults.
  delete config.ui;
  delete config.integrations;
  delete config.notifications;
  return dump(config, { noRefs: true, sortKeys: true, lineWidth: -1 });
}

export function verifyAuthoritativeTaskState(state) {
  if (!state) {
    throw new Error('Smoke failed: authoritative Task state was not provided');
  }
  if (state.acceptedProposalCount !== 1) {
    throw new Error(`Smoke failed: expected exactly one accepted proposal, found ${state.acceptedProposalCount}`);
  }
  if (state.tasks.length !== 1) {
    throw new Error(`Smoke failed: expected exactly one authoritative Task, found ${state.tasks.length}`);
  }

  const task = state.tasks[0];
  if (task.status !== 'done') {
    throw new Error([
      `Smoke failed: authoritative Task ${task.id} is ${task.status}, not done.`,
      `Authoritative state: ${formatAuthoritativeFailure(state)}`,
    ].join('\n'));
  }

  const subtasks = state.subtasks.filter(subtask => subtask.taskId === task.id);
  if (subtasks.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no Subtasks`);
  }
  const unfinishedSubtask = subtasks.find(subtask => subtask.status !== 'done');
  if (unfinishedSubtask) {
    throw new Error(`Smoke failed: authoritative Subtask ${unfinishedSubtask.id} is ${unfinishedSubtask.status}, not done`);
  }

  for (const subtask of subtasks) {
    const latestReceipt = state.receipts.find(receipt => (
      receipt.taskId === task.id && receipt.subtaskId === subtask.id
    ));
    if (!latestReceipt || latestReceipt.terminalState !== 'completed') {
      throw new Error([
        `Smoke failed: latest receipt for Subtask ${subtask.id} is ${latestReceipt?.terminalState ?? 'missing'}, not completed.`,
        `Authoritative state: ${formatAuthoritativeFailure(state)}`,
      ].join('\n'));
    }
  }

  const publications = state.publications.filter(publication => publication.taskId === task.id);
  if (publications.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no workspace publication`);
  }
  const unfinishedPublication = publications.find(publication => publication.status !== 'integrated');
  if (unfinishedPublication) {
    throw new Error(`Smoke failed: workspace publication ${unfinishedPublication.id} is ${unfinishedPublication.status}, not integrated`);
  }

  const dispatchItems = state.dispatchItems.filter(item => item.taskId === task.id);
  if (dispatchItems.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no dispatch items`);
  }
  const unfinishedDispatch = dispatchItems.find(item => item.status !== 'terminal');
  if (unfinishedDispatch) {
    throw new Error(`Smoke failed: dispatch ${unfinishedDispatch.attemptId} is ${unfinishedDispatch.status}, not terminal`);
  }

  return {
    taskId: task.id,
    artifacts: subtasks.flatMap(subtask => parseJsonArray(subtask.artifactsJson)),
  };
}

export function verifyArtifactScenario(input) {
  const authoritative = verifyAuthoritativeTaskState(input.authoritativeState);
  const artifactPath = authoritative.artifacts
    .map(String)
    .find(artifact => artifact.replaceAll('\\', '/').endsWith('/smoke-result.md'));
  if (!artifactPath) {
    throw new Error('Smoke failed: authoritative Subtask artifacts do not include smoke-result.md');
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

  return { artifactPath, taskId: authoritative.taskId };
}

export function verifyPythonHelloScenario(input) {
  const authoritative = verifyAuthoritativeTaskState(input.authoritativeState);
  const pythonFile = authoritative.artifacts
    .map(String)
    .find(artifact => artifact.replaceAll('\\', '/').endsWith(`/${pythonHelloFileName}`));
  if (!pythonFile) {
    throw new Error(`Smoke failed: authoritative Subtask artifacts do not include ${pythonHelloFileName}`);
  }
  if (!existsSync(pythonFile)) {
    throw new Error(`Smoke failed: published artifact does not exist: ${pythonFile}`);
  }
  const source = readFileSync(pythonFile, 'utf-8').trimEnd();
  if (source !== pythonHelloSource) {
    throw new Error(`Smoke failed: ${pythonFile} content was ${JSON.stringify(source)}, expected ${JSON.stringify(pythonHelloSource)}`);
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

  if ((result.stdout ?? '').trim() !== pythonHelloOutput) {
    throw new Error(`Smoke failed: independent Python stdout was "${(result.stdout ?? '').trim()}"`);
  }

  return { artifactPath: pythonFile, pythonCommand, taskId: authoritative.taskId };
}

export function verifyPlannerSessionScenario(input) {
  if (input.sessionFiles.length !== 1) {
    throw new Error(
      `Smoke failed: expected exactly one persisted AnyFusion-Pi session file for two turns, found ${input.sessionFiles.length}`,
    );
  }
  const recall = input.interactions.find(row => String(row.userInput ?? '').includes('刚才的测试短语是什么'));
  if (!recall || !String(recall.systemOutput ?? '').includes(plannerMemoryMarker)) {
    throw new Error(`Smoke failed: the second Planner reply did not recall the marker from its persisted AnyFusion-Pi session. Observed output: ${String(recall?.systemOutput ?? '<missing>')}`);
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
    maxBuffer: 100 * 1024 * 1024,
    shell: options.shell ?? false,
  });

  if (options.logPath) {
    writeFileSync(options.logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const termination = result.error?.message
      ?? (result.signal ? `terminated by ${result.signal}` : `exit code ${result.status}`);
    throw new Error(`${command} ${args.join(' ')} failed: ${termination}`);
  }

  return result;
}

function readPlannerDiagnostics(repoRoot, dbPath) {
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

function readPlannerInteractions(repoRoot, dbPath) {
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

export function resolveSmokeMode(rawArgs, env, repoRoot = process.cwd()) {
  const explicit = readOption(rawArgs, '--mode') ?? env.METACLAW_SMOKE_MODE;
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== '') {
    const mode = String(explicit).trim();
    if (mode !== 'native' && mode !== 'docker') {
      throw new Error(`Invalid smoke mode: ${explicit}. Expected one of: native, docker`);
    }
    return mode;
  }
  // Docker is an optional compatibility surface; native is always the default.
  return 'native';
}

export function buildNativeSmokeOverlay(env = process.env, repoRoot = resolve(process.cwd())) {
  const configHome = resolve(env.ANYFUSION_CONFIG_HOME ?? join(homedir(), '.config', 'anyfusion'));
  const providerEnvFile = join(configHome, 'provider.env');
  const plannerHome = join(configHome, 'planner');
  const codexHome = join(configHome, 'codex');
  const piHome = join(configHome, 'pi-home');
  const plannerCommand = env.METACLAW_PLANNER_COMMAND
    ?? join(repoRoot, 'planner', 'AnyFusion-Pi', 'packages', 'coding-agent', 'dist', 'cli.js');
  const requiredPaths = [
    providerEnvFile,
    plannerCommand,
    join(plannerHome, 'models.json'),
    join(plannerHome, 'settings.json'),
    join(codexHome, 'config.toml'),
    join(piHome, '.pi', 'agent', 'models.json'),
    join(piHome, '.pi', 'agent', 'settings.json'),
  ];
  for (const requiredPath of requiredPaths) {
    if (!existsSync(requiredPath)) {
      throw new Error([
        `Native smoke requires ${requiredPath}.`,
        'Run `npm run setup:native` to install the native AnyFusion configuration,',
        'or configure the docker/*.env files and rerun with --mode docker.',
      ].join(' '));
    }
  }
  return {
    METACLAW_PLANNER_COMMAND: plannerCommand,
    METACLAW_PLANNER_TUI_COMMAND: plannerCommand,
    METACLAW_PLANNER_HOME: plannerHome,
    ANYFUSION_PLANNER_HOME: plannerHome,
    METACLAW_PLANNER_ENV_FILE: providerEnvFile,
    METACLAW_EXECUTOR_BACKEND: 'worktree',
    METACLAW_EXECUTOR_CODEX_HOME: codexHome,
    METACLAW_CODEX_EXECUTOR_ENV_FILE: providerEnvFile,
    METACLAW_EXECUTOR_PI_HOME: piHome,
    METACLAW_PI_EXECUTOR_ENV_FILE: providerEnvFile,
    METACLAW_PI_ATTEMPT_EXTENSION: join(repoRoot, 'dist', 'pi-attempt-tools.ts'),
  };
}

export function runSmoke(rawArgs = process.argv.slice(2), env = process.env) {
  if (env.METACLAW_SMOKE_IN_DOCKER === 'true') {
    runManagedSmoke(rawArgs, env);
    return;
  }
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }
  if (resolveSmokeMode(rawArgs, env) === 'docker') {
    runDockerSmoke(rawArgs, env);
    return;
  }
  runManagedSmoke(rawArgs, env, buildNativeSmokeOverlay(env));
}

function runManagedSmoke(rawArgs, env, overlayEnv = null) {
  const repoRoot = resolve(env.METACLAW_SMOKE_REPO_ROOT ?? process.cwd());
  const executorCommand = parseExecutorCommand(
    readOption(rawArgs, '--executor') ?? env.METACLAW_SMOKE_EXECUTOR ?? 'codex',
  );
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const executorTimeout = parsePositiveInteger(
    readOption(rawArgs, '--timeout') ?? env.METACLAW_SMOKE_TIMEOUT,
    900,
  );
  const executorMaxDuration = parsePositiveInteger(
    readOption(rawArgs, '--max-duration') ?? env.METACLAW_SMOKE_MAX_DURATION,
    3600,
  );

  const smokeRoot = env.METACLAW_SMOKE_ROOT ? resolve(env.METACLAW_SMOKE_ROOT) : tmpdir();
  mkdirSync(smokeRoot, { recursive: true });
  const installRoot = env.ANYFUSION_INSTALL_ROOT
    ? resolve(env.ANYFUSION_INSTALL_ROOT)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-install-'));
  const metaclawHome = join(installRoot, 'data');
  const accountPaths = resolveSmokeAccountPaths(installRoot);
  const workdir = env.METACLAW_SMOKE_WORKDIR
    ? resolve(env.METACLAW_SMOKE_WORKDIR)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-work-'));
  const scriptDir = env.METACLAW_SMOKE_SCRIPT_DIR
    ? resolve(env.METACLAW_SMOKE_SCRIPT_DIR)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-script-'));
  for (const directory of [metaclawHome, workdir, scriptDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const scriptPath = join(scriptDir, 'script.txt');
  const outputPath = join(scriptDir, 'metaclaw-output.log');
  let succeeded = false;

  try {
    writeFileSync(join(metaclawHome, 'config.yaml'), buildSmokeConfig({
      repoRoot,
      templatePath: env.METACLAW_SMOKE_CONFIG_TEMPLATE,
      executorCommand,
      executorTimeout,
      executorMaxDuration,
    }));

    writeFileSync(scriptPath, buildScenarioScript(scenario));

    if (env.METACLAW_SMOKE_SKIP_BUILD !== 'true') {
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
    }
    const configHome = overlayEnv?.ANYFUSION_PLANNER_HOME
      ? resolve(overlayEnv.ANYFUSION_PLANNER_HOME, '..')
      : resolve(env.ANYFUSION_CONFIG_HOME ?? join(homedir(), '.config', 'anyfusion'));
    run('node', [
      join(repoRoot, 'dist', 'prepare-smoke-configuration.js'),
      installRoot,
      configHome,
    ], {
      cwd: repoRoot,
      env: {
        ...(overlayEnv ?? {}),
        METACLAW_SMOKE_EXECUTOR: executorCommand,
        METACLAW_SMOKE_EXECUTOR_TIMEOUT: String(executorTimeout),
        METACLAW_SMOKE_EXECUTOR_MAX_DURATION: String(executorMaxDuration),
      },
    });
    const plannerSessionDir = accountPaths.plannerSessions;
    // Keep the bridge socket path short: macOS rejects Unix socket paths
    // longer than 104 bytes, and tmpdir() roots are already deep.
    const bridgeSocketPath = join(scriptDir, 'bridge.sock');
    const childEnv = {
      ...(overlayEnv ?? {}),
      ANYFUSION_INSTALL_ROOT: installRoot,
      METACLAW_HOME: metaclawHome,
      METACLAW_PLANNER_SESSION_DIR: plannerSessionDir,
      METACLAW_PLANNER_SCHEMA_PATH: join(repoRoot, 'dist', 'planning-agent-plan-v8.schema.json'),
      METACLAW_PLANNER_HOST_SOCKET: bridgeSocketPath,
      METACLAW_PLANNER_TUI_SOCKET: bridgeSocketPath,
      METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
    };
    const runResult = run('node', [join(repoRoot, 'dist/index.js'), '--script', scriptPath], {
      cwd: workdir,
      env: childEnv,
      logPath: outputPath,
    });

    const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
    if (executorCommand === 'pi' && !output.includes('pi-agent')) {
      process.stderr.write(output);
      throw new Error('Smoke failed: expected route/execution output to mention pi-agent');
    }

    const authoritativeState = scenario === 'planner-session'
      ? null
      : readAuthoritativeTaskState(accountPaths.database);

    const verification = scenario === 'planner-session'
      ? verifyPlannerSessionScenario({
        interactions: readPlannerInteractions(repoRoot, accountPaths.database),
        sessionFiles: findFiles(
          plannerSessionDir,
          filePath => filePath.endsWith('.jsonl'),
        ),
      })
      : scenario === 'artifact'
        ? verifyArtifactScenario({ output, workdir, authoritativeState })
        : verifyPythonHelloScenario({ output, workdir, authoritativeState });

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
    succeeded = true;
  } catch (error) {
    const plannerDiagnostics = readPlannerDiagnostics(repoRoot, accountPaths.database);
    if (plannerDiagnostics) process.stderr.write(`Planner diagnostics: ${plannerDiagnostics}\n`);
    process.stderr.write([
      'Smoke failed; diagnostics were preserved:',
      `  ANYFUSION_INSTALL_ROOT: ${installRoot}`,
      `  METACLAW_HOME: ${metaclawHome}`,
      `  Workdir: ${workdir}`,
      `  Output: ${outputPath}`,
      '',
    ].join('\n'));
    throw error;
  } finally {
    if (succeeded && env.METACLAW_SMOKE_MANAGED_BY_HOST !== 'true') {
      removeTree(installRoot);
      removeTree(workdir);
      removeTree(scriptDir);
    }
  }
}

// Immutable configuration revisions and Git objects are written read-only;
// make the tree writable before deleting it.
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
    spawnSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
}

function runDockerSmoke(rawArgs, env) {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }
  const repoRoot = resolve(process.cwd());
  if (!existsSync(join(repoRoot, 'planner', 'AnyFusion-Pi', 'package.json'))) {
    throw new Error('Smoke requires the vendored AnyFusion-Pi planner at planner/AnyFusion-Pi');
  }
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const plannerTimeoutMs = parsePositiveInteger(env.METACLAW_PLANNER_TIMEOUT_MS, 180_000);
  const smokeRoot = mkdtempSync(join(tmpdir(), 'metaclaw-docker-smoke-'));
  const dataRoot = join(smokeRoot, 'data');
  const workspaceRoot = join(smokeRoot, 'workspace');
  const auxiliaryRoot = join(smokeRoot, 'auxiliary');
  for (const directory of [dataRoot, workspaceRoot, auxiliaryRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const suffix = `${process.pid}-${Date.now()}`;
  const control = `metaclaw-smoke-control-${suffix}`;
  const runtimeImage = 'metaclaw-runtime';
  const mounts = [
    ['docker/planner-pi.env', '/run/metaclaw/env/planner-pi.env'],
    ['docker/executor-codex.env', '/run/metaclaw/env/executor-codex.env'],
    ['docker/executor-pi.env', '/run/metaclaw/env/executor-pi.env'],
  ];
  for (const [hostPath] of mounts) {
    if (!existsSync(join(repoRoot, hostPath))) {
      throw new Error(`Smoke requires ${hostPath}; copy the corresponding .env.example and configure the provider.`);
    }
  }

  let succeeded = false;
  try {
    run('docker', [
      'build',
      '-f', 'docker/Dockerfile.runtime',
      '-t', runtimeImage,
      '.',
    ], { cwd: repoRoot });
    const createArgs = [
      'create', '--name', control, '--network', 'bridge',
      '--workdir', '/workspace',
      '--mount', `type=bind,src=${workspaceRoot},dst=/workspace`,
      '--mount', `type=bind,src=${dataRoot},dst=/data`,
      '--mount', `type=bind,src=${auxiliaryRoot},dst=/smoke`,
      ...mounts.flatMap(([hostPath, containerPath]) => [
        '--mount', `type=bind,src=${join(repoRoot, hostPath)},dst=${containerPath},readonly`,
      ]),
      '-e', 'METACLAW_SMOKE_IN_DOCKER=true',
      '-e', 'METACLAW_SMOKE_SKIP_BUILD=true',
      '-e', 'METACLAW_SMOKE_REPO_ROOT=/app',
      '-e', 'METACLAW_SMOKE_CONFIG_TEMPLATE=/opt/metaclaw/default-config.yaml',
      '-e', 'METACLAW_SMOKE_ROOT=/smoke',
      '-e', 'METACLAW_SMOKE_SCRIPT_DIR=/smoke/script',
      '-e', 'METACLAW_SMOKE_WORKDIR=/workspace',
      '-e', 'METACLAW_SMOKE_MANAGED_BY_HOST=true',
      '-e', 'ANYFUSION_INSTALL_ROOT=/data/anyfusion',
      '-e', `METACLAW_PLANNER_TIMEOUT_MS=${plannerTimeoutMs}`,
      '-e', 'METACLAW_EXECUTOR_BACKEND=worktree',
      runtimeImage,
      'node', '/app/scripts/smoke-metaclaw-real-task.mjs',
      ...rawArgs,
    ];
    run('docker', createArgs, { cwd: repoRoot });
    const result = run('docker', ['start', '--attach', control], { cwd: repoRoot });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    succeeded = true;
  } finally {
    spawnSync('docker', ['rm', '-f', control], { cwd: repoRoot, encoding: 'utf8' });
    if (succeeded) {
      rmSync(smokeRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`Docker smoke diagnostics preserved at: ${smokeRoot}\n`);
    }
  }
}

function buildHelp() {
  return [
    'Usage: npm run smoke:metaclaw -- [--mode <native|docker>] [--executor <command>] [--scenario <planner-session|artifact|python-hello>] [--timeout <seconds>] [--max-duration <seconds>]',
    '',
    'Modes:',
    '  native (default)  Run the Runtime and Planner as native host processes. Uses the',
    '                    native AnyFusion configuration under ANYFUSION_CONFIG_HOME',
    '                    (default ~/.config/anyfusion) installed by `npm run setup:native`.',
    '  docker            Build the unified runtime image and run the smoke inside a',
    '                    control container. Requires the docker/*.env provider files.',
    '                    Only used when explicitly requested; Docker is not needed otherwise.',
    '',
    'Environment variables:',
    '  METACLAW_SMOKE_MODE          Smoke mode: native or docker. Defaults to native.',
    '  ANYFUSION_CONFIG_HOME        Native configuration home. Defaults to ~/.config/anyfusion.',
    '  METACLAW_SMOKE_EXECUTOR      Executor command to place in the isolated config. Defaults to codex.',
    '  METACLAW_SMOKE_SCENARIO      Scenario to run. Defaults to planner-session (two-turn AnyFusion Planner memory).',
    '  METACLAW_SMOKE_TIMEOUT       Continuous no-output timeout in seconds.',
    '  METACLAW_SMOKE_MAX_DURATION  Legacy max_duration value in seconds.',
    '  METACLAW_PLANNER_TIMEOUT_MS   Planner RPC timeout forwarded to the Runtime; Docker smoke defaults to 180000.',
    '  METACLAW_SMOKE_IN_DOCKER      Internal recursion guard; Docker smoke runs set it inside the control container.',
    '',
    'Examples:',
    '  npm run smoke:metaclaw',
    '  npm run smoke:metaclaw -- --executor pi --scenario python-hello',
    '  npm run smoke:metaclaw -- --mode docker --scenario artifact',
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
