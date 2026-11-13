import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const smokeRoot = mkdtempSync(join(
  process.platform === 'darwin' ? '/tmp' : tmpdir(),
  'mwg-',
));
const installRoot = join(smokeRoot, 'install');
const smokeHome = join(smokeRoot, 'home');
const workspaceA = join(smokeRoot, 'workspace-a');
const workspaceB = join(smokeRoot, 'workspace-b');
const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const rootAcceptanceFiles = [
  'tests/architecture/no-direct-client-session-paths.test.ts',
  'tests/architecture/unified-server-composition.test.ts',
  'tests/integration/unified-client-runtime.integration.test.ts',
  'tests/integration/workspace-directory-recovery.integration.test.ts',
  'tests/security/gateway-account-isolation.test.ts',
  'tests/security/workspace-directory-account-isolation.test.ts',
  'tests/gateway/server-lifecycle.test.ts',
  'tests/gateway/workspace-gateway-runtime.test.ts',
  'tests/gateway/gateway-load.test.ts',
  'tests/gateway/feishu-conversation-routing.test.ts',
  'tests/gateway/feishu-gateway-session-port.test.ts',
  'tests/integration/independent-client-lifecycle.integration.test.ts',
  'tests/client/tui-client-launcher.test.ts',
  'tests/client/web-client-launcher.test.ts',
  'tests/workspace/conversation-workspace-service.test.ts',
  'tests/management/web-launch-context.test.ts',
  'tests/management/web-gateway-session-runtime.test.ts',
  'tests/server/server-endpoint-manifest.test.ts',
  'tests/server/server-lifecycle.test.ts',
  'tests/web/gateway-contract-parity.test.ts',
  'tests/web/workspace-shell.test.ts',
];
const releaseId = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
).version;
const runtimeEntry = join(installRoot, 'app', 'current', 'dist', 'index.js');
const endpointManifest = join(installRoot, 'server-endpoint.json');
const nativeEnvironment = {
  ...process.env,
  HOME: smokeHome,
  METAWORK_INSTALL_ROOT: installRoot,
  METAWORK_SECRET_STORE: 'file',
  METAWORK_PROVIDER_KEY: 'gateway-smoke-key',
  METAWORK_PROVIDER_URL: 'https://provider.invalid/v1',
  METAWORK_PROVIDER_MODEL: 'gateway-smoke-model',
  METAWORK_PROVIDER_REGION: 'international',
  METAWORK_WEB_PORT: '0',
  METACLAW_DISABLE_MARKDOWN_PREVIEW: '1',
};

mkdirSync(smokeHome, { recursive: true });
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });

let activeServer = null;
try {
  runAcceptance('Unified Gateway acceptance', vitest, rootAcceptanceFiles, repoRoot);
  installNativeRelease();
  activeServer = await runNativeMultiClientAcceptance();
  process.stdout.write(`Unified Gateway smoke passed with isolated root ${smokeRoot}\n`);
} finally {
  if (activeServer?.exitCode === null) activeServer.kill('SIGTERM');
  // restart 会 detached 启动新实例：按 manifest PID 兜底清理，避免遗留进程。
  try {
    if (existsSync(endpointManifest)) {
      const pid = JSON.parse(readFileSync(endpointManifest, 'utf8')).pid;
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
    }
  } catch {
    // best-effort cleanup only
  }
  removeTree(smokeRoot);
}

function runAcceptance(label, runner, files, cwd) {
  runSync(label, process.execPath, [runner, 'run', ...files], {
    cwd,
    env: {
      ...process.env,
      METAWORK_INSTALL_ROOT: installRoot,
    },
    inherit: true,
  });
}

function installNativeRelease() {
  assertBuilt(join(repoRoot, 'dist', 'install-cli.js'), 'run `npm run build` first');
  // ADR-0055 D6: the release carries the packaged upstream Pi. Stage it first
  // (or point the Server at an explicit runtime) so readiness can resolve it.
  assertBuilt(
    process.env.METAWORK_MANAGED_PI ?? join(repoRoot, 'desktop-tools', 'executor', 'bin', 'pi'),
    'stage the packaged Pi (npm run build-release --package-only) or set METAWORK_MANAGED_PI',
  );
  runSync('Native release installation', process.execPath, [
    join(repoRoot, 'dist/install-cli.js'),
    'install',
    releaseId,
    '--source-root',
    repoRoot,
  ], {
    cwd: repoRoot,
    env: nativeEnvironment,
  });
}

async function runNativeMultiClientAcceptance() {
  let server = await startServer('start');
  try {
    assertNoRetiredTuiChild(server.child.pid);

    const manifest = readManifest();
    const clientA = await connectClient(manifest.unixSocketPath, 'smoke_a');
    const clientB = await connectClient(manifest.unixSocketPath, 'smoke_b');
    const clientC = await connectClient(manifest.unixSocketPath, 'smoke_c');

    try {
      const selectedA = await clientA.selectWorkspace(workspaceA);
      const selectedB = await clientB.selectWorkspace(workspaceA);
      if (!selectedA.workspaceId || selectedA.workspaceId !== selectedB.workspaceId) {
        throw new Error('Clients in Workspace A resolved different workspaceId values');
      }

      let created;
      const workspaceReadyDeadline = Date.now() + 30_000;
      do {
        created = await clientA.createConversation(selectedA.workspaceId);
        if (created.status !== 'rejected' || created.reason !== 'workspace_initializing') break;
        if (Date.now() >= workspaceReadyDeadline) throw new Error('Workspace initialization timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      assertAccepted(created, 'Workspace A Conversation creation');
      if (!created.conversationId) throw new Error('Conversation creation returned no ID');
      await clientB.waitForEvent(event => (
        event.kind === 'workspace_conversation_upserted'
        && event.payload?.conversation?.conversationId === created.conversationId
      ));

      const selectedC = await clientC.selectWorkspace(workspaceB);
      if (!selectedC.workspaceId || selectedC.workspaceId === selectedA.workspaceId) {
        throw new Error('Workspace B did not receive an isolated workspaceId');
      }
      const listedC = await clientC.listWorkspaceConversations(selectedC.workspaceId);
      const workspaceBPage = await clientC.waitForEvent(event => (
        event.kind === 'workspace_directory_snapshot'
        && event.requestId === listedC.requestId
      ));
      if (workspaceBPage.payload?.page?.items?.length !== 0) {
        throw new Error(`Workspace B unexpectedly contains Workspace A Conversations: ${
          JSON.stringify(workspaceBPage)} (workspaceB=${selectedC.workspaceId} workspaceA=${selectedA.workspaceId})`);
      }

      await assertInstalledWebClient(manifest.webOrigin);
      runStatusCommand('正在运行');

      clientA.close();
      clientB.close();
      clientC.close();

      const oldPid = readManifest().pid;
      const restarting = await startServer('restart');
      await waitForExit(server.child);
      server = restarting;
      const restartedManifest = readManifest();
      if (restartedManifest.pid === oldPid) throw new Error('Server restart did not replace the PID');

      const restored = await connectClient(restartedManifest.unixSocketPath, 'smoke_restored');
      try {
        const restoredWorkspace = await restored.selectWorkspace(workspaceA);
        if (restoredWorkspace.workspaceId !== selectedA.workspaceId) {
          throw new Error('Workspace A identity changed after Server restart');
        }
        const restoredList = await restored.listWorkspaceConversations(restoredWorkspace.workspaceId);
        const restoredPage = await restored.waitForEvent(event => (
          event.kind === 'workspace_directory_snapshot'
          && event.requestId === restoredList.requestId
        ));
        if (!restoredPage.payload?.page?.items?.some(
          item => item.conversationId === created.conversationId,
        )) {
          throw new Error('Conversation directory did not recover after Server restart');
        }
      } finally {
        restored.close();
      }

      await runServerCommand('Server stop', 'stop');
      await waitForExit(server.child);
      process.stdout.write('Native multi-client process acceptance passed\n');
      return server.child;
    } finally {
      clientA.close();
      clientB.close();
      clientC.close();
    }
  } catch (error) {
    if (server.child.exitCode === null) {
      await runServerCommand('Server stop after failure', 'stop', true);
      await waitForExit(server.child).catch(() => server.child.kill('SIGTERM'));
    }
    throw error;
  }
}

async function startServer(action) {
  let output = '';
  const child = spawn(process.execPath, [runtimeEntry, 'server', action], {
    cwd: workspaceA,
    env: nativeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  // `server start` 前台运行并打印 "MetaWork Server ready:"；`server restart`
  // 会 detached 拉起新实例并打印 "MetaWork Server 已启动。" 后自身退出。
  const ready = () => existsSync(endpointManifest) && (
    output.includes('MetaWork Server ready:')
    || output.includes('MetaWork Server 已启动。')
  );
  await waitFor(ready, 30_000, () => {
    if (child.exitCode !== null && !ready()) {
      throw new Error(`Server ${action} exited early (${child.exitCode}): ${output}`);
    }
  });
  return { child, output: () => output };
}

async function runServerCommand(label, action, allowFailure = false) {
  let output = '';
  const child = spawn(process.execPath, [runtimeEntry, 'server', action], {
    cwd: workspaceA,
    env: nativeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForExit(child);
  if (child.exitCode !== 0 && !allowFailure) {
    throw new Error(`${label} failed with exit code ${child.exitCode}: ${output}`);
  }
  return output;
}

/**
 * Installed Server gateway client: the released Server speaks the v2 JSONL
 * socket protocol (ADR-0031). No vendored client library is involved, so this
 * exercises exactly what a third-party client sees.
 */
async function connectClient(socketPath, connectionId) {
  const socket = createConnection(socketPath);
  const messages = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  await new Promise((resolvePromise, reject) => {
    socket.once('connect', resolvePromise);
    socket.once('error', reject);
  });
  await nextMessage(message => message.type === 'hello');

  let requestSequence = 0;
  function nextMessage(predicate, timeoutMs = 30_000) {
    return new Promise((resolvePromise, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const index = messages.findIndex(predicate);
        if (index >= 0) {
          resolvePromise(messages.splice(index, 1)[0]);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`gateway message not received after ${timeoutMs}ms`));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  async function request(scope, command) {
    requestSequence += 1;
    const requestId = `smoke_${connectionId}_${requestSequence}`;
    socket.write(`${JSON.stringify({
      type: 'command',
      envelope: {
        protocolVersion: 2,
        requestId,
        idempotencyKey: `idem_${requestId}`,
        connectionId,
        scope,
        command,
        clientCapabilities: ['trace_v1'],
      },
    })}\n`);
    const receipt = await nextMessage(message => (
      message.type === 'receipt' && message.receipt.requestId === requestId
    ));
    return { requestId, ...receipt.receipt };
  }

  return {
    selectWorkspace(path) {
      return request({ kind: 'workspace' }, { kind: 'select_workspace', path });
    },
    createConversation(workspaceId) {
      return request({ kind: 'workspace' }, { kind: 'create_conversation', workspaceId });
    },
    listWorkspaceConversations(workspaceId) {
      return request({ kind: 'workspace' }, { kind: 'list_workspace_conversations', workspaceId });
    },
    async waitForEvent(predicate) {
      const message = await nextMessage(m => m.type === 'event' && predicate(m.event));
      return message.event;
    },
    close() {
      socket.destroy();
    },
  };
}

async function assertInstalledWebClient(webOrigin) {
  const index = await fetch(`${webOrigin}/`).then(response => response.text());
  if (!index.includes('<div id="root">')) {
    throw new Error('Installed Server did not serve the released Web bundle');
  }
  const session = await fetch(`${webOrigin}/api/auth/session`);
  if (!session.ok) {
    throw new Error(`Installed Web session endpoint returned HTTP ${session.status}`);
  }
}

function runStatusCommand(expected) {
  const result = runSync('Server status', process.execPath, [
    runtimeEntry,
    'server',
    'status',
  ], {
    cwd: workspaceA,
    env: nativeEnvironment,
    capture: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase();
  if (!output.includes(expected)) {
    throw new Error(`Server status did not include ${expected}: ${output}`);
  }
}

function readManifest() {
  return JSON.parse(readFileSync(endpointManifest, 'utf8'));
}

/** ADR-0055 D6/D11: the Server must not spawn the removed fork or a TUI client. */
function assertNoRetiredTuiChild(serverPid) {
  const result = spawnSync('ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return;
  const retired = result.stdout.split(/\r?\n/u).some(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return Number(match?.[1]) === serverPid
      && /coding-agent\/dist\/cli\.js|anyfusion-planner|meta(w|claw)-tui/iu.test(match?.[2] ?? '');
  });
  if (retired) throw new Error('Server start unexpectedly launched a retired TUI/Planner process');
}

function assertAccepted(receipt, label) {
  if (receipt.status === 'rejected') {
    throw new Error(`${label} rejected: ${receipt.reason ?? 'unknown reason'}`);
  }
}

async function waitFor(predicate, timeoutMs, inspect = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    inspect();
    if (Date.now() >= deadline) throw new Error('acceptance condition timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`process ${child.pid} did not exit`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    const onExit = () => {
      cleanup();
      resolvePromise();
    };
    child.once('exit', onExit);
  });
}

function assertBuilt(path, hint) {
  if (!existsSync(path)) throw new Error(`${path} is missing; ${hint}`);
}

// Native installation revisions are immutable, so restore owner write access before cleanup.
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
    spawnSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
}

function runSync(label, command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${label} failed with exit code ${result.status}: `
      + `${result.stderr ?? result.stdout ?? ''}`,
    );
  }
  return result;
}
