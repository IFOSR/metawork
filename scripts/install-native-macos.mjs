import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plannerRoot = resolve(
  process.env.ANYFUSION_PI_SOURCE_ROOT ?? join(runtimeRoot, 'planner', 'AnyFusion-Pi'),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function requireNodeVersion() {
  const actual = process.versions.node.split('.').map(Number);
  const minimum = [22, 19, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error(`install-native-macos requires macOS; found ${process.platform}`);
  }
  requireNodeVersion();
  requiredEnvironment('ANYFUSION_PROVIDER_KEY');
  requiredEnvironment('ANYFUSION_PROVIDER_URL');
  process.env.ANYFUSION_PROVIDER_MODEL ??= 'gpt-5.6-terra';
  process.env.ANYFUSION_PROVIDER_REGION ??= 'international';

  run('npm', ['ci'], runtimeRoot);
  run('npm', ['run', 'build'], runtimeRoot);
  run('npm', ['ci', '--ignore-scripts'], plannerRoot);
  run('npm', ['run', 'build:offline'], plannerRoot);

  const releaseId = JSON.parse(
    readFileSync(join(runtimeRoot, 'package.json'), 'utf8'),
  ).version;
  run('node', [
    join(runtimeRoot, 'dist', 'install-cli.js'),
    'install',
    releaseId,
    '--source-root',
    runtimeRoot,
    '--planner-root',
    plannerRoot,
  ], runtimeRoot);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `AnyFusion native installation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
