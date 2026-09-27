import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function resolveInstallRoot() {
  const metaworkRoot = process.env.METAWORK_INSTALL_ROOT?.trim();
  const anyFusionRoot = process.env.ANYFUSION_INSTALL_ROOT?.trim();
  if (metaworkRoot && anyFusionRoot && metaworkRoot !== anyFusionRoot) {
    throw new Error(
      'METAWORK_INSTALL_ROOT conflicts with compatibility variable ANYFUSION_INSTALL_ROOT',
    );
  }
  return resolve(metaworkRoot || anyFusionRoot || join(homedir(), '.metawork'));
}

function resolveRuntime(installRoot) {
  const runtimeEntry = join(installRoot, 'app', 'current', 'dist', 'index.js');
  if (!existsSync(runtimeEntry)) {
    throw new Error(
      `MetaWork installed runtime not found at ${runtimeEntry}; `
      + 'run `npm run setup:native` before starting the Server',
    );
  }

  const identityPath = join(installRoot, 'app', 'current', 'release-identity.json');
  let releaseId;
  if (existsSync(identityPath)) {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (typeof identity.releaseId === 'string' && identity.releaseId.length > 0) {
      releaseId = identity.releaseId;
    }
  }

  return { runtimeEntry, releaseId };
}

function signalExitCode(signal) {
  const signalNumber = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  }[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

function main() {
  const installRoot = resolveInstallRoot();
  const { runtimeEntry, releaseId } = resolveRuntime(installRoot);
  const env = {
    ...process.env,
    METAWORK_INSTALL_ROOT: installRoot,
    ANYFUSION_INSTALL_ROOT: installRoot,
  };
  if (releaseId) {
    env.METAWORK_RELEASE_ID = releaseId;
  } else {
    delete env.METAWORK_RELEASE_ID;
  }

  const child = spawn(process.execPath, [runtimeEntry, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  let finished = false;
  const forwardSignal = signal => {
    if (!finished) child.kill(signal);
  };
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.on(signal, forwardSignal);
  }

  child.once('error', error => {
    if (finished) return;
    finished = true;
    process.stderr.write(`MetaWork runtime failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (finished) return;
    finished = true;
    for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      process.off(name, forwardSignal);
    }
    process.exitCode = signal ? signalExitCode(signal) : (code ?? 1);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `MetaWork installed runtime unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
