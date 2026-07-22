import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerCliAttemptSandboxAdapter } from '../../src/execution/docker-cli-attempt-sandbox-adapter.js';
import { DEFAULT_ATTEMPT_SANDBOX_LIMITS } from '../../src/execution/attempt-sandbox.js';

const exec = promisify(execFile);
const enabled = process.env.METACLAW_RUN_DOCKER_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;

suite('Docker attempt sandbox integration', () => {
  let root = '';
  const network = `metaclaw-test-${process.pid}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'metaclaw-docker-attempt-'));
    await exec('docker', ['network', 'create', '--internal', network]);
  });

  afterAll(async () => {
    await exec('docker', ['network', 'rm', network]).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('keeps source read-only, workspace writable, and exposes no Docker socket', async () => {
    const workspace = join(root, 'workspace');
    const source = join(root, 'source');
    const inputs = join(root, 'inputs');
    const handoffs = join(root, 'handoffs');
    const gitMetadata = join(root, 'git-metadata');
    await Promise.all([workspace, source, inputs, handoffs, gitMetadata].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(source, 'source.txt'), 'immutable\n');
    const sandbox = new DockerCliAttemptSandboxAdapter();
    const imageRef = process.env.METACLAW_TEST_ATTEMPT_IMAGE ?? 'metaclaw-executor-codex:phase5';
    const imageId = await sandbox.resolveImage(imageRef);
    const record = await sandbox.create({
      attemptId: 'integration-attempt', taskId: 'integration-task', generationId: 'generation-1',
      subtaskId: 'subtask-1', workUnitId: 'worker-1', leaseToken: 'lease-1', idempotencyKey: 'integration-1',
      imageRef, resolvedImageId: imageId, command: '/bin/sh',
      args: ['-c', [
        'echo workspace-ok > /workspace/result.txt',
        'echo tmp-ok > /tmp/result.txt',
        'test ! -S /var/run/docker.sock',
        '! echo forbidden > /source/source.txt',
        '! echo forbidden > /inputs/forbidden.txt',
        '! echo forbidden > /handoffs/forbidden.txt',
        '! echo forbidden > /workspace/.git/forbidden.txt',
        "! timeout 2 bash -c 'echo probe > /dev/tcp/1.1.1.1/80'",
      ].join('; ')],
      environment: {},
      mounts: [
        { source: workspace, target: '/workspace', mode: 'rw' },
        { source, target: '/source', mode: 'ro' },
        { source: inputs, target: '/inputs', mode: 'ro' },
        { source: handoffs, target: '/handoffs', mode: 'ro' },
        { source: gitMetadata, target: '/workspace/.git', mode: 'ro' },
      ],
      controlNetwork: network, egressMode: 'disabled', limits: DEFAULT_ATTEMPT_SANDBOX_LIMITS,
    });
    await sandbox.start(record.containerId);
    expect(await sandbox.wait(record.containerId)).toBe(0);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toContain('workspace-ok');
    expect(await readFile(join(source, 'source.txt'), 'utf8')).toBe('immutable\n');
    const inspect = JSON.parse((await exec('docker', ['inspect', record.containerId], { encoding: 'utf8' })).stdout)[0];
    expect(inspect.HostConfig.Privileged).toBe(false);
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapDrop).toContain('ALL');
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(inspect.HostConfig.NetworkMode).toBe(network);
    expect(inspect.HostConfig.PidMode).not.toBe('host');
    expect(inspect.HostConfig.IpcMode).not.toBe('host');
    expect(inspect.HostConfig.Devices ?? []).toEqual([]);
    expect(inspect.Mounts.find((mount: { Destination: string }) => mount.Destination === '/workspace/.git')?.RW).toBe(false);
    await sandbox.remove(record.containerId);
  });
});
