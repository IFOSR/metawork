import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const plannerRoot = resolve(repoRoot, 'planner/AnyFusion-Pi');
const plannerVitest = join(
  plannerRoot,
  'packages',
  'coding-agent',
  'node_modules',
  'vitest',
  'vitest.mjs',
);
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
const plannerAcceptanceFiles = [
  'test/anyfusion-client-mode.test.ts',
  'test/anyfusion-gateway-client.test.ts',
  'test/metawork-conversation-selector.test.ts',
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
  runAcceptance(
    'Planner TUI acceptance',
    plannerVitest,
    plannerAcceptanceFiles,
    join(plannerRoot, 'packages', 'coding-agent'),
  );
  installNativeRelease();
  activeServer = await runNativeMultiClientAcceptance();
  process.stdout.write(`Unified Gateway smoke passed with isolated root ${smokeRoot}\n`);
} finally {
  if (activeServer?.exitCode === null) activeServer.kill('SIGTERM');
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
  assertBuilt(
    join(plannerRoot, 'packages', 'coding-agent', 'dist', 'cli.js'),
    'run the vendored Planner build first',
  );
  runSync('Native release installation', process.execPath, [
    join(repoRoot, 'dist/install-cli.js'),
    'install',
    releaseId,
    '--source-root',
    repoRoot,
    '--planner-root',
    plannerRoot,
  ], {
    cwd: repoRoot,
    env: nativeEnvironment,
  });
}

async function runNativeMultiClientAcceptance() {
  let server = await startServer('start');
  try {
    assertNoPlannerChild(server.child.pid);
    await runInstalledTui(workspaceA);

    const manifest = readManifest();
    const {
      GatewayClient,
      GatewaySocketTransport,
    } = await loadInstalledGatewayClient();
    const clientA = await createClient(GatewayClient, GatewaySocketTransport, manifest.unixSocketPath);
    const clientB = await createClient(GatewayClient, GatewaySocketTransport, manifest.unixSocketPath);
    const clientC = await createClient(GatewayClient, GatewaySocketTransport, manifest.unixSocketPath);

    try {
      const selectedA = await clientA.client.initializeWorkspace(`/workspace ${workspaceA}`);
      const selectedB = await clientB.client.initializeWorkspace(`/workspace ${workspaceA}`);
      assertAccepted(selectedA, 'TUI Client A Workspace selection');
      assertAccepted(selectedB, 'Web Client B Workspace selection');
      if (!selectedA.workspaceId || selectedA.workspaceId !== selectedB.workspaceId) {
        throw new Error('Clients in Workspace A resolved different workspaceId values');
      }

      const created = await clientA.client.createConversation(selectedA.workspaceId);
      assertAccepted(created, 'Workspace A Conversation creation');
      if (!created.conversationId) throw new Error('Conversation creation returned no ID');
      await waitForEvent(clientB.events, event => (
        event.kind === 'workspace_conversation_upserted'
        && event.payload?.conversation?.conversationId === created.conversationId
      ));

      await clientA.client.resume(created.conversationId);
      const helpReceipt = await clientA.client.submitSlashCommand('/help', {
        mode: 'attach',
        conversationId: created.conversationId,
      });
      assertAccepted(helpReceipt, 'attached Client command');
      await waitForEvent(clientA.events, event => (
        event.requestId === helpReceipt.requestId
        && (event.kind === 'final_answer' || event.kind === 'conversation_snapshot')
      ));
      if (clientB.events.some(event => event.requestId === helpReceipt.requestId)) {
        throw new Error('Unattached Client B received Conversation detail');
      }

      await clientB.client.resume(created.conversationId);
      await waitForEvent(clientB.events, event => event.requestId === helpReceipt.requestId);

      const selectedC = await clientC.client.initializeWorkspace(`/workspace ${workspaceB}`);
      assertAccepted(selectedC, 'TUI Client C Workspace selection');
      if (!selectedC.workspaceId || selectedC.workspaceId === selectedA.workspaceId) {
        throw new Error('Workspace B did not receive an isolated workspaceId');
      }
      const listC = await clientC.client.listWorkspaceConversations(selectedC.workspaceId);
      assertAccepted(listC, 'Workspace B directory query');
      const workspaceBPage = await waitForEvent(clientC.events, event => (
        event.kind === 'workspace_directory_snapshot'
        && event.requestId === listC.requestId
      ));
      if (workspaceBPage.payload?.page?.items?.length !== 0) {
        throw new Error('Workspace B unexpectedly contains Workspace A Conversations');
      }

      await runWebClient(workspaceA);
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

      const restored = await createClient(
        GatewayClient,
        GatewaySocketTransport,
        restartedManifest.unixSocketPath,
      );
      try {
        const restoredWorkspace = await restored.client.initializeWorkspace(`/workspace ${workspaceA}`);
        assertAccepted(restoredWorkspace, 'Workspace A restore after restart');
        if (restoredWorkspace.workspaceId !== selectedA.workspaceId) {
          throw new Error('Workspace A identity changed after Server restart');
        }
        const restoredList = await restored.client.listWorkspaceConversations(
          restoredWorkspace.workspaceId,
        );
        const restoredPage = await waitForEvent(restored.events, event => (
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
  await waitFor(() => (
    existsSync(endpointManifest)
    && output.includes('MetaWork Server ready:')
  ), 30_000, () => {
    if (child.exitCode !== null) {
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

async function runInstalledTui(cwd) {
  if (process.platform !== 'darwin') return;
  const launcher = join(smokeHome, '.local', 'bin', 'metawork');
  let output = '';
  const tui = spawn('/usr/bin/script', [
    '-q',
    '/dev/null',
    launcher,
    'tui',
  ], {
    cwd,
    env: nativeEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tui.stdout.on('data', chunk => { output += chunk.toString(); });
  tui.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    await waitFor(() => (
      output.includes('connected')
      && output.includes(basename(cwd))
    ), 30_000, () => {
      if (tui.exitCode !== null) {
        throw new Error(`Installed TUI exited early (${tui.exitCode}): ${output}`);
      }
    });
  } finally {
    if (tui.exitCode === null) tui.kill('SIGTERM');
    await waitForExit(tui).catch(() => tui.kill('SIGKILL'));
  }
}

async function loadInstalledGatewayClient() {
  const root = join(installRoot, 'app', 'current', 'planner', 'packages', 'coding-agent', 'dist');
  const clientModule = await import(pathToFileURL(join(root, 'anyfusion/gateway-client.js')).href);
  const transportModule = await import(
    pathToFileURL(join(root, 'anyfusion/gateway-socket-transport.js')).href
  );
  return {
    GatewayClient: clientModule.GatewayClient,
    GatewaySocketTransport: transportModule.GatewaySocketTransport,
  };
}

async function createClient(GatewayClient, GatewaySocketTransport, socketPath) {
  const transport = new GatewaySocketTransport(socketPath);
  const client = new GatewayClient(transport);
  const events = [];
  const unsubscribe = client.onEvent(event => events.push(event));
  await client.connect();
  return {
    client,
    events,
    close() {
      unsubscribe();
      client.dispose();
      transport.close();
    },
  };
}

async function runWebClient(cwd) {
  const result = runSync('Web Client launch', process.execPath, [
    runtimeEntry,
    'web',
    '--no-open',
  ], {
    cwd,
    env: nativeEnvironment,
    capture: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!output.includes('MetaWork Web Client:')) {
    throw new Error(`Web Client did not report its URL: ${output}`);
  }
  if (output.includes(workspaceA) || output.includes('workspace=')) {
    throw new Error('Web Client URL exposed the Workspace path');
  }
  const url = /MetaWork Web Client:\s*(\S+)/u.exec(output)?.[1];
  if (!url) throw new Error(`Web Client URL could not be parsed: ${output}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Web Client URL returned HTTP ${response.status}: ${url}`);
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

function assertNoPlannerChild(serverPid) {
  const result = spawnSync('ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return;
  const plannerChild = result.stdout.split(/\r?\n/u).some(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return Number(match?.[1]) === serverPid
      && /coding-agent\/dist\/cli\.js|anyfusion-planner/iu.test(match?.[2] ?? '');
  });
  if (plannerChild) throw new Error('Server start unexpectedly launched a TUI/Planner Client');
}

function assertAccepted(receipt, label) {
  if (receipt.status === 'rejected') {
    throw new Error(`${label} rejected: ${receipt.reason ?? 'unknown reason'}`);
  }
}

async function waitForEvent(events, predicate, timeoutMs = 15_000) {
  let found;
  await waitFor(() => {
    found = events.find(predicate);
    return Boolean(found);
  }, timeoutMs);
  return found;
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
