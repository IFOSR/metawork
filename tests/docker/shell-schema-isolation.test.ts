import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Docker shell SQLite schema isolation', () => {
  it('uses a data volume scoped to the current pre-release schema', () => {
    const migrations = readFileSync(
      resolve('src/storage/migrations.ts'),
      'utf-8',
    );
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const version = migrations.match(/CURRENT_SCHEMA_VERSION = (\d+);/)?.[1];

    expect(version).toBeTruthy();
    expect(shell).toContain(
      `$dataVolume = 'metaclaw-shell-data-v${version}'`,
    );
  });

  it('mounts the Docker socket and recreates stale containers without that mount', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');

    expect(shell).toContain(
      "--mount 'type=bind,src=//var/run/docker.sock,dst=/var/run/docker.sock'",
    );
    expect(shell).toContain('function Test-ContainerHasDockerSocket');
    expect(shell).toContain('if (-not (Test-ContainerHasDockerSocket))');
    expect(shell).toContain('Start-ShellContainer');
  });

  it('bootstraps the Docker-internal control-plane topology used by attempt sandboxes', () => {
    const shell = readFileSync(resolve('docker/shell.ps1'), 'utf-8');
    const persistEnv = readFileSync(resolve('docker/persist-ssh-environment.sh'), 'utf-8');

    expect(shell).toContain("$controlNetwork = 'metaclaw-control'");
    expect(shell).toContain("$controlHost = 'metaclaw-control'");
    expect(shell).toContain('docker network create --internal $controlNetwork');
    expect(shell).toContain('--network bridge');
    expect(shell).toContain('docker network connect --alias $controlHost $controlNetwork $container');
    expect(shell).toContain('-e METACLAW_CONTROL_NETWORK=$controlNetwork');
    expect(shell).toContain('-e METACLAW_CONTROL_HOST=$controlHost');
    expect(shell).toContain('-e "METACLAW_DOCKER_HOST_PATH_MAP=$hostPathMap"');
    expect(shell).toContain('function Build-DockerHostPathMap');
    expect(shell).toContain('function Ensure-AttemptImages');
    expect(shell).toContain('function Test-ContainerHasControlNetwork');
    expect(shell).toContain('function Test-ContainerHasBridgeNetwork');
    expect(shell).toContain('function Test-ContainerHasControlEnv');
    expect(shell).toContain('if (-not (Test-ContainerHasControlNetwork)');
    expect(persistEnv).toContain('METACLAW_CONTROL_NETWORK');
    expect(persistEnv).toContain('METACLAW_CONTROL_HOST');
    expect(persistEnv).toContain('METACLAW_DOCKER_HOST_PATH_MAP');
  });
});
