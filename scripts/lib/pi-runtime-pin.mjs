/**
 * Build-time Pi runtime pin (ADR-0055 D6).
 *
 * The packaged Manager and Executor run the upstream Pi version that the
 * packaging host has installed at build time. This module resolves that exact
 * version, proves it comes from the managed Pi install layout, and fails the
 * build when Pi is missing, mismatched or needs a newer Node than the product
 * supports. It never reads the user's Pi configuration, sessions, extensions or
 * auth files: only the launcher, `--version`, the release `package.json` and the
 * release lockfile are inspected.
 */
import { createHash } from 'node:crypto';
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MIN_NODE = [22, 19, 0];

/**
 * @typedef {object} PiRuntimePin
 * @property {string} commandPath   Real path of the `pi` launcher that was probed.
 * @property {string} version       Version reported by `pi --version`.
 * @property {string} agentRoot     Managed agent root (`<agentRoot>/install/releases/...`).
 * @property {string} releaseDir    Directory of the pinned release.
 * @property {string} packageName   Installed Pi package name.
 * @property {string} packageVersion Installed Pi package version (must equal `version`).
 * @property {string | null} nodeEngine Declared Node engine range, when present.
 * @property {string | null} lockSha256 sha256 of the release lockfile (integrity witness).
 */

/**
 * @param {{
 *   command?: string,
 *   env?: Record<string, string | undefined>,
 *   execFileSync?: typeof defaultExecFileSync,
 * }} [options]
 * @returns {PiRuntimePin}
 */
export function probePiRuntimePin(options = {}) {
  const command = options.command ?? process.env.METAWORK_PI_COMMAND ?? 'pi';
  const env = options.env ?? process.env;
  const exec = options.execFileSync ?? defaultExecFileSync;

  const commandPath = resolveCommand(command, env, exec);
  const version = readVersion(commandPath, exec);
  const agentRoot = findManagedAgentRoot(commandPath, env, version);
  if (!agentRoot) {
    throw new Error(
      `packaged Pi must come from the managed install layout: ${commandPath} is not under `
      + `<agentRoot>/bin and no candidate root has install/releases/${version}`,
    );
  }
  const releaseDir = join(agentRoot, 'install', 'releases', version);
  const packageJsonPath = join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `packaged Pi ${version} is missing its release package: ${packageJsonPath}; `
      + 'install that exact version before building MetaWork',
    );
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.version !== version) {
    throw new Error(
      `packaged Pi version mismatch: launcher reports ${version} but ${packageJsonPath} declares ${packageJson.version}`,
    );
  }
  const lockPath = join(releaseDir, 'package-lock.json');
  return {
    commandPath,
    version,
    agentRoot,
    releaseDir,
    packageName: String(packageJson.name ?? ''),
    packageVersion: String(packageJson.version),
    nodeEngine: typeof packageJson.engines?.node === 'string' ? packageJson.engines.node : null,
    lockSha256: existsSync(lockPath)
      ? createHash('sha256').update(readFileSync(lockPath)).digest('hex')
      : null,
  };
}

/**
 * @param {{
 *   command?: string,
 *   env?: Record<string, string | undefined>,
 *   execFileSync?: typeof defaultExecFileSync,
 *   hostNodeVersion?: string,
 * }} [options]
 * @returns {PiRuntimePin}
 */
export function assertPiRuntimePin(options = {}) {
  const pin = probePiRuntimePin(options);
  const hostNode = options.hostNodeVersion ?? process.versions.node;
  if (compareNode(hostNode, MIN_NODE) < 0) {
    throw new Error(`MetaWork requires Node >= ${MIN_NODE.join('.')} to bundle Pi; host has ${hostNode}`);
  }
  if (pin.nodeEngine) {
    const minimum = minimumFromRange(pin.nodeEngine);
    if (minimum && compareNode(hostNode, minimum) < 0) {
      throw new Error(
        `packaged Pi ${pin.version} requires Node ${pin.nodeEngine}; host has ${hostNode}`,
      );
    }
  }
  return pin;
}

function resolveCommand(command, env, exec) {
  if (command.includes('/')) {
    const resolved = realpathSync(command);
    if (!existsSync(resolved)) throw new Error(`packaged Pi executable not found: ${command}`);
    return resolved;
  }
  const which = exec(process.platform === 'win32' ? 'where' : 'which', [command], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  }).trim().split('\n')[0];
  if (!which) throw new Error(`packaged Pi executable not found on PATH: ${command}`);
  return realpathSync(which);
}

function readVersion(commandPath, exec) {
  const output = String(exec(commandPath, ['--version'], { encoding: 'utf8' })).trim();
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(output);
  if (!match) {
    throw new Error(`cannot read the packaged Pi version from \`${commandPath} --version\`: ${output}`);
  }
  return match[1];
}

function findManagedAgentRoot(commandPath, env, version) {
  const candidates = [];
  // The launcher that actually ran is authoritative: <agentRoot>/bin/pi.
  const binDir = dirname(commandPath);
  if (binDir.endsWith('/bin')) candidates.push(dirname(binDir));
  // An explicitly configured root is only a fallback, and must contain the
  // version the launcher reported.
  const managedRoot = env.PI_MANAGED_INSTALL_ROOT;
  if (managedRoot) candidates.push(dirname(managedRoot));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'install', 'releases', version))) return candidate;
  }
  return null;
}

function compareNode(left, right) {
  const a = String(left).split('-')[0].split('.').map(part => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function minimumFromRange(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(range);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export { MIN_NODE };
