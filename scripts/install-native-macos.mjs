import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderLauncher,
  renderProviderEnv,
} from './native-install-lib.mjs';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plannerRoot = resolve(
  process.env.ANYFUSION_PI_SOURCE_ROOT ?? join(runtimeRoot, 'planner', 'AnyFusion-Pi'),
);
const configHome = resolve(process.env.ANYFUSION_CONFIG_HOME ?? join(homedir(), '.config', 'anyfusion'));
const binHome = resolve(process.env.ANYFUSION_BIN_HOME ?? join(homedir(), '.local', 'bin'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? runtimeRoot,
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? String(result.stdout).trim() : '';
}

function requireCommand(command) {
  run(command, ['--version'], { capture: true });
}

async function requireExecutableOnPath(command) {
  const searchPath = process.env.PATH ?? '';
  for (const directory of searchPath.split(delimiter)) {
    const candidate = join(directory || process.cwd(), command);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
      return candidate;
    }
  }
  throw new Error(`${command} must already be installed and available on PATH`);
}

function requireNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
}

async function exists(path) {
  return access(path, constants.F_OK).then(() => true, () => false);
}

async function resolveProviderOrPrompt() {
  const apiKey = process.env.ANYFUSION_PROVIDER_KEY?.trim();
  const baseUrl = process.env.ANYFUSION_PROVIDER_URL?.trim();
  if (apiKey && baseUrl) {
    return { apiKey, baseUrl: baseUrl.replace(/\/+$/u, '') };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const resolvedKey = apiKey || (await rl.question('OpenAI-compatible provider API key: '));
    const resolvedUrl = baseUrl || (await rl.question('OpenAI-compatible provider base URL (e.g. https://api.openai.com/v1): '));
    return {
      apiKey: resolvedKey.trim(),
      baseUrl: resolvedUrl.trim().replace(/\/+$/u, ''),
    };
  } finally {
    rl.close();
  }
}

async function installPlanner() {
  // The AnyFusion-Pi planner is vendored under planner/AnyFusion-Pi in this
  // repository; installation only hydrates dependencies and builds it.
  if (!(await exists(join(plannerRoot, 'package.json')))) {
    throw new Error(
      `AnyFusion-Pi planner sources are missing at ${plannerRoot}; `
      + 'reinstall or clone the complete AnyFusion repository.',
    );
  }
  run('npm', ['ci', '--ignore-scripts'], { cwd: plannerRoot });
  run('npm', ['run', 'build:offline'], { cwd: plannerRoot });
}

async function buildRuntime() {
  run('npm', ['ci'], { cwd: runtimeRoot });
  run('npm', ['run', 'build'], { cwd: runtimeRoot });
}

async function renderTemplate(source, destination, baseUrl) {
  const template = await readFile(source, 'utf8');
  await writeFile(destination, template.replaceAll('__OPENAI_BASE_URL__', baseUrl), { mode: 0o600 });
  await chmod(destination, 0o600);
}

async function installConfiguration(provider) {
  const plannerHome = join(configHome, 'planner');
  const codexHome = join(configHome, 'codex');
  const piHome = join(configHome, 'pi-home', '.pi', 'agent');
  await Promise.all([
    mkdir(plannerHome, { recursive: true, mode: 0o700 }),
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(piHome, { recursive: true, mode: 0o700 }),
    mkdir(binHome, { recursive: true, mode: 0o700 }),
    mkdir(join(homedir(), '.local', 'share', 'anyfusion'), { recursive: true, mode: 0o700 }),
  ]);
  const providerPath = join(configHome, 'provider.env');
  await writeFile(providerPath, renderProviderEnv(provider), { mode: 0o600 });
  await chmod(providerPath, 0o600);
  await Promise.all([
    renderTemplate(
      join(runtimeRoot, 'docker', 'planner-pi-config', 'models.json'),
      join(plannerHome, 'models.json'),
      provider.baseUrl,
    ),
    renderTemplate(
      join(runtimeRoot, 'docker', 'codex-config', 'executor', 'config.toml'),
      join(codexHome, 'config.toml'),
      provider.baseUrl,
    ),
    renderTemplate(
      join(runtimeRoot, 'docker', 'pi-config', 'models.json'),
      join(piHome, 'models.json'),
      provider.baseUrl,
    ),
  ]);
  await Promise.all([
    copyFile(
      join(runtimeRoot, 'docker', 'planner-pi-config', 'settings.json'),
      join(plannerHome, 'settings.json'),
    ),
    copyFile(
      join(runtimeRoot, 'docker', 'pi-config', 'settings.json'),
      join(piHome, 'settings.json'),
    ),
  ]);
  await Promise.all([
    chmod(join(plannerHome, 'settings.json'), 0o600),
    chmod(join(piHome, 'settings.json'), 0o600),
  ]);
  const launcherScript = renderLauncher({ runtimeRoot, plannerRoot, configHome });
  const launcherPath = join(binHome, 'metawork');
  await writeFile(launcherPath, launcherScript, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  const anyfusionAlias = join(binHome, 'anyfusion');
  await writeFile(anyfusionAlias, launcherScript, { mode: 0o700 });
  await chmod(anyfusionAlias, 0o700);
  return launcherPath;
}

async function ensureShellPath() {
  const zshrc = join(homedir(), '.zshrc');
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const current = await readFile(zshrc, 'utf8').catch(() => '');
  if (current.split('\n').some(item => item.trim() === line)) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(zshrc, `${current}${prefix}\n# AnyFusion native launcher\n${line}\n`);
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error(`install-native-macos requires macOS; found ${process.platform}`);
  }
  requireNodeVersion();
  for (const command of ['git', 'npm']) requireCommand(command);
  await Promise.all([
    requireExecutableOnPath('codex'),
    requireExecutableOnPath('pi'),
  ]);
  const provider = await resolveProviderOrPrompt();
  await installPlanner();
  await buildRuntime();
  const launcherPath = await installConfiguration(provider);
  await ensureShellPath();
  process.stdout.write(`AnyFusion native installation complete.\nLauncher: ${launcherPath}\n`);
  process.stdout.write('Alias: ~/.local/bin/anyfusion\n');
  process.stdout.write('Existing Codex and Pi installations were detected and left unchanged.\n');
  process.stdout.write('Open a new shell, then run `metawork` from the project directory it should inspect.\n');
}

main().catch(error => {
  process.stderr.write(`AnyFusion native installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
