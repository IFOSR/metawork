import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Real installed Planner/Pi task acceptance. Never records provider inputs,
// model responses, process command lines or database contents in CI artifacts.
export async function runPackagedModelTasks({ page, root, installRoot, evidence, onActiveTask }) {
  assert.equal(process.platform, 'win32');
  const release = await realpath(join(installRoot, 'app/current'));
  const require = createRequire(join(release, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(installRoot, 'accounts/local-default/data/anyfusion.db'), { readonly: true, fileMustExist: true });
  const clientRoot = join(release, 'planner/packages/coding-agent/dist/anyfusion');
  const { GatewayClient } = await import(pathToFileURL(join(clientRoot, 'gateway-client.js')));
  const { GatewaySocketTransport } = await import(pathToFileURL(join(clientRoot, 'gateway-socket-transport.js')));
  const endpoint = JSON.parse(await readFile(join(installRoot, 'server-endpoint.json'), 'utf8'));
  const transport = new GatewaySocketTransport(endpoint.unixSocketPath);
  const client = new GatewayClient(transport);
  const report = { passed: false, platform: process.platform, realProvider: true,
    taskSubmittedThroughPackagedWeb: false, artifactVerified: false, cancellationVerified: false };
  // Only public release identity is included below, never the model settings.
  report.releaseId = JSON.parse(await readFile(join(release, 'release-identity.json'), 'utf8')).releaseId;
  const waitFor = async (check, label, timeoutMs = 600_000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await check();
      if (result) return result;
      await new Promise(done => setTimeout(done, 1000));
    } while (Date.now() < deadline);
    throw new Error(`Real task acceptance timed out: ${label}`);
  };
  const accepted = receipt => {
    assert.notEqual(receipt.status, 'rejected', 'Gateway rejected acceptance command');
    return receipt;
  };
  try {
    await client.connect();
    const workspace = join(root, '中文 task workspace');
    await mkdir(workspace, { recursive: true });
    const selected = accepted(await client.initializeWorkspace(`/workspace ${workspace}`));
    const created = accepted(await client.createConversation(selected.workspaceId));
    assert.ok(created.conversationId);
    await page.goto(`${endpoint.webOrigin}/#${new URLSearchParams({ workspace: selected.workspaceId, conversation: created.conversationId })}`);
    const composer = page.locator('.composer textarea');
    await composer.waitFor({ state: 'visible' });
    const marker = `MetaWork Windows acceptance ${randomUUID()}`;
    await composer.fill(`Create smoke-result.md in the managed Task workspace with exactly this line: ${marker}. Use the Pi Executor to create the file, publish it as a file artifact, and finish the task. The Runtime supplies the authorized directory; do not ask for a path.`);
    await page.locator('.composer button[type=submit]').click();
    report.taskSubmittedThroughPackagedWeb = true;
    console.log('Installed packaged Web submitted the real artifact request.');
    const task = await waitFor(() => {
      const rows = db.prepare('SELECT id, status FROM tasks ORDER BY created_at').all();
      assert.ok(rows.length <= 1, 'The artifact request created duplicate Tasks');
      const row = rows[0];
      if (row && ['failed', 'cancelled'].includes(row.status)) throw new Error(`Artifact Task ended as ${row.status}`);
      return row?.status === 'done' ? row : null;
    }, 'artifact Task completion');
    const subtasks = db.prepare('SELECT id, status, artifacts_json AS artifacts FROM subtasks WHERE task_id = ?').all(task.id);
    assert.ok(subtasks.length > 0);
    assert.ok(subtasks.every(row => row.status === 'done'));
    const publications = db.prepare('SELECT status FROM workspace_publications WHERE task_id = ?').all(task.id);
    assert.ok(publications.length > 0 && publications.every(row => row.status === 'integrated'));
    for (const subtask of subtasks) {
      const receipt = db.prepare('SELECT terminal_state AS state FROM executor_attempt_receipts WHERE task_id = ? AND subtask_id = ? ORDER BY completed_at DESC LIMIT 1').get(task.id, subtask.id);
      assert.equal(receipt?.state, 'completed');
    }
    const artifacts = subtasks.flatMap(row => JSON.parse(row.artifacts));
    const artifact = artifacts.find(value => typeof value === 'string' && value.replaceAll('\\', '/').endsWith('/smoke-result.md'));
    assert.ok(artifact, 'No published smoke-result.md artifact');
    const artifactPath = await realpath(artifact);
    const allowedRoots = await Promise.all([installRoot, workspace].map(path => realpath(path)));
    assert.ok(allowedRoots.some(parent => {
      const child = relative(parent, artifactPath);
      return child && child !== '..' && !child.startsWith('..\\') && !isAbsolute(child);
    }), 'Artifact escaped the disposable test roots');
    assert.equal((await readFile(artifactPath, 'utf8')).trim(), marker);
    report.artifactVerified = true;
    report.artifactTaskId = task.id;
    console.log('Installed Planner, Executor, publication and artifact content verified.');
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM planner_proposal_submissions WHERE status = 'accepted'").get().count > 0);
    await page.screenshot({ path: join(evidence, 'real-artifact-task.png') });

    const cancelMarker = `mw-cancel-${randomUUID()}`;
    await composer.fill(`Cancellation acceptance: run a Bash command that prints ${cancelMarker} once per second for 300 seconds. Include that literal marker in the command text. Start it now, keep the task active until it finishes, and do not create or modify files. I will cancel it from the client.`);
    await page.locator('.composer button[type=submit]').click();
    const processIds = async () => {
      const script = `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process);
        $ids=[Collections.Generic.HashSet[int]]::new();
        foreach($item in $items) { if($item.CommandLine -and $item.CommandLine.Contains('${cancelMarker}')) { [void]$ids.Add([int]$item.ProcessId) } }
        do { $added=$false; foreach($item in $items) { if($ids.Contains([int]$item.ParentProcessId)) { if($ids.Add([int]$item.ProcessId)) { $added=$true } } } } while($added);
        @($ids | Sort-Object) | ConvertTo-Json -Compress`;
      const { stdout } = await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
      const value = JSON.parse(stdout.trim() || '[]');
      return Array.isArray(value) ? value : [value];
    };
    const running = await waitFor(async () => {
      const ids = await processIds();
      return ids.length ? ids : null;
    }, 'real Executor command running');
    const cancellationTask = db.prepare('SELECT id FROM tasks WHERE id != ? ORDER BY created_at DESC LIMIT 1').get(task.id);
    assert.ok(cancellationTask, 'No Task owns the running cancellation command');
    console.log('Real cancellation command is running in an Executor process.');
    if (onActiveTask) {
      await onActiveTask();
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(cancellationTask.id)?.status, 'running');
      assert.ok((await processIds()).length, 'Declining uninstall stopped active Executor work');
      report.activeUninstallDeclinedWithoutStopping = true;
    }
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.composer .stop-button').click();
    await waitFor(async () => {
      if (db.prepare('SELECT status FROM tasks WHERE id = ?').get(cancellationTask.id)?.status !== 'cancelled') return false;
      if ((await processIds()).length) return false;
      return running.every(pid => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      });
    }, 'cancelled Task and Executor process cleanup', 60000);
    report.cancellationVerified = true;
    report.cancelledTaskId = cancellationTask.id;
    report.cancelledProcessCount = running.length;
    report.passed = true;
    console.log('Client cancellation and Executor descendant cleanup verified.');
    await page.screenshot({ path: join(evidence, 'real-cancelled-task.png') });
  } finally {
    report.taskStates = db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all();
    report.proposalStates = db.prepare('SELECT status, COUNT(*) AS count FROM planner_proposal_submissions GROUP BY status').all();
    client.dispose(); transport.close(); db.close();
    await writeFile(join(evidence, 'real-model-task.json'), JSON.stringify(report, null, 2));
  }
}
