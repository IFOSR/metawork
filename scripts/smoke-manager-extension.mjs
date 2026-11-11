#!/usr/bin/env node
// Real-Pi smoke for the Manager extension (P2-B3).
//
// Proves the packaged upstream Pi can load MetaWork's Manager extension and
// answer the RPC handshake without a model call, so a broken extension is caught
// before a planning turn is attempted. Not part of the default suite because it
// needs the upstream Pi install.
//
//   node scripts/smoke-manager-extension.mjs [--pi <path>] [--workspace <dir>]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The environment allow-list is duplicated here on purpose: this script runs
// against source, and importing TS from a .mjs entry would need a loader.
function buildManagerEnvironment({ managerHome, configDir, sessionDir, explicit }) {
  const passthrough = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  const env = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = managerHome;
  env.PI_CODING_AGENT_DIR = configDir;
  env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  env.METAWORK_MANAGER_HOST_PROTOCOL = '1';
  env.PI_TELEMETRY = 'off';
  return { env: { ...env, ...explicit } };
}
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const piCommand = option('pi') ?? 'pi';
const workspace = resolve(option('workspace') ?? repoRoot);
const extension = join(repoRoot, 'src', 'planning', 'manager-host', 'extension', 'index.ts');
if (!existsSync(extension)) {
  process.stderr.write(`manager extension not found: ${extension}\n`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'metawork-manager-smoke-'));
const { env } = buildManagerEnvironment({
  managerHome: home,
  configDir: join(home, 'config'),
  sessionDir: join(home, 'sessions'),
  explicit: { METAWORK_MANAGER_WORKSPACE: workspace, PI_CODING_AGENT_DIR: join(home, 'config') },
});

const child = spawn(piCommand, [
  '--mode', 'rpc', '--no-session',
  '--extension', extension,
], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

const records = [];
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) records.push(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

const send = record => child.stdin.write(`${JSON.stringify(record)}\n`);
const waitFor = (predicate, timeoutMs = 20_000) => new Promise((resolvePromise, rejectPromise) => {
  const startedAt = Date.now();
  const tick = () => {
    const found = records.find(predicate);
    if (found) return resolvePromise(found);
    if (Date.now() - startedAt > timeoutMs) {
      return rejectPromise(new Error(`timed out waiting for pi rpc record; stderr=${stderr.slice(0, 800)}`));
    }
    setTimeout(tick, 50);
  };
  tick();
});

const fail = message => {
  process.stderr.write(`smoke-manager-extension failed: ${message}\n`);
  child.kill('SIGKILL');
  process.exit(1);
};

try {
  send({ id: 'state-1', type: 'get_state' });
  const state = await waitFor(record => record.type === 'response' && record.id === 'state-1');
  if (!state.success) fail(`get_state failed: ${state.error ?? 'unknown'}`);
  if (!state.data?.sessionId) fail('get_state returned no session id');

  send({ id: 'commands-1', type: 'get_commands' });
  const commands = await waitFor(record => record.type === 'response' && record.id === 'commands-1');
  if (!commands.success) fail(`get_commands failed: ${commands.error ?? 'unknown'}`);

  if (/extension.*(?:failed|error)/iu.test(stderr) && !/no such file/iu.test(stderr)) {
    fail(`pi reported an extension error: ${stderr.slice(0, 800)}`);
  }
  process.stdout.write([
    'smoke-manager-extension: ok',
    `  pi: ${piCommand}`,
    `  workspace: ${workspace}`,
    `  isolated home: ${home}`,
    `  session: ${state.data.sessionId}`,
    '',
  ].join('\n'));
  child.kill('SIGTERM');
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
