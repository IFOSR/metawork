import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';

describe('PiCliDriver', () => {
  it('launches with independent HOME and Pi directories', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const launch = driver.buildLaunch({
      prompt: 'research current information',
      cwd: '/workspace/task',
      runtimeHomePath: '/attempt/home',
    });

    expect(launch).toEqual({
      command: 'pi',
      args: ['-p', 'research current information'],
      cwd: '/workspace/task',
      environment: {
        HOME: '/attempt/home',
        PI_CODING_AGENT_DIR: '/attempt/home/.pi/agent',
        PI_CODING_AGENT_SESSION_DIR: '/attempt/home/.pi/agent/sessions',
      },
    });
    expect(JSON.stringify(launch)).not.toContain('~/.pi');
  });

  it('normalizes result output and redacts diagnostics', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    expect(driver.parseResult({ exitCode: 1, stdout: '', stderr: 'token=sk-secret' }))
      .toEqual({ success: false, output: '', error: 'token=[REDACTED]' });
  });

  it('pre-creates an isolated Pi session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-driver-'));
    try {
      const driver = new PiCliDriver({ probeCommand: vi.fn() });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: root,
      });

      expect(await stat(home.environment.PI_CODING_AGENT_SESSION_DIR)).toBeTruthy();
      expect(home.environment.HOME).toBe(home.homePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
