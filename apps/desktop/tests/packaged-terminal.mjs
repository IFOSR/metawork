import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pause = ms => new Promise(done => setTimeout(done, ms));
export async function packagedTerminal({ installRoot, evidence, env }) {
  const endpoint = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8'));
  const report = { passed: false, realTerminal: true, terminalKind: process.platform === 'win32' ? 'ConPTY' : 'POSIX PTY',
    serverPid: endpoint.pid };
  let child, exited, output = '', attached;
  const waitFor = async (check, label, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (exited !== undefined) throw new Error(`Installed TUI exited before ${label}: ${exited}`);
      if (Date.now() >= deadline) throw new Error(`Installed TUI timed out: ${label}`);
      await pause(100);
    }
  };
  // Inspect bounded rendered output in memory; do not publish model text or
  // terminal contents. Reports contain only assertions and public Task IDs.
  const compact = value => value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, '').replace(/\s/gu, '');
  const contains = value => compact(output).includes(compact(value));
  const start = async () => {
    output = ''; exited = undefined;
    const node = join(installRoot, 'app/current/desktop-tools/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    const args = [node, join(installRoot, 'app/current/dist/index.js'), 'tui', '--conversation', attached.conversationId];
    const windows = process.platform === 'win32';
    const carrier = windows ? fileURLToPath(new URL('../../../.tmp/windows-terminal-probe/Release/metawork-terminal-client.exe', import.meta.url)) : '/usr/bin/python3';
    child = spawn(carrier, windows ? args : [fileURLToPath(new URL('./terminal-client.py', import.meta.url)), ...args],
      { cwd: attached.workspace, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const capture = data => { output = (output + data).slice(-262144); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => { exited = 'spawn-error'; });
    child.on('exit', (code, signal) => { exited = code ?? signal; });
    await waitFor(() => contains('MetaWork'), 'actual TUI rendering');
  };
  const exit = async () => {
    if (!child || exited !== undefined) return;
    child.stdin.write('\x04'); // Actual Ctrl+D is the product's client-only exit.
    const deadline = Date.now() + 15000;
    while (exited === undefined && Date.now() < deadline) await pause(100);
    assert.equal(exited, 0, 'TUI did not exit cleanly through its terminal binding');
    process.kill(endpoint.pid, 0);
  };
  return {
    async workspace(value) { attached = value; await start(); report.installedLauncherConnected = true; },
    async artifact({ marker, taskId }) {
      await waitFor(() => contains(marker) && contains('已完成'), 'same artifact Task completion');
      output = ''; child.stdin.write('\x1b[17~'); // F6: actual Task Dashboard.
      await waitFor(() => contains('Task Dashboard'), 'Task Dashboard keyboard interaction');
      child.stdin.write('\x1b');
      report.taskDashboardRendered = true; report.artifactTaskId = taskId;
    },
    async running({ marker, taskId }) {
      await waitFor(() => contains(marker) && contains('进行中'), 'same active Task');
      await exit();
      report.exitedDuringTask = taskId;
      await start();
      await waitFor(() => contains(marker) && contains('进行中'), 'reconnected active Task');
      report.reconnectedToSameRunningTask = true;
    },
    async cancelled({ marker, taskId }) {
      await waitFor(() => contains(marker) && contains('已取消'), 'authoritative cancellation');
      assert.equal(JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8')).pid, endpoint.pid);
      report.cancelledTaskId = taskId; report.serverInstancePreserved = true; report.passed = true;
    },
    async close() {
      try { await exit(); }
      finally {
        if (child && exited === undefined) child.kill('SIGKILL');
        await writeFile(join(evidence, 'native-terminal.json'), JSON.stringify(report, null, 2));
      }
    },
  };
}
