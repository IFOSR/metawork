import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';

describe('CodexCliDriver', () => {
  it('launches only with generated CODEX_HOME and no process fallback', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    const launch = driver.buildLaunch({
      prompt: 'implement change',
      cwd: '/workspace/task',
      runtimeHomePath: '/attempt/home',
    });

    expect(launch).toEqual({
      command: 'codex',
      args: ['exec', 'implement change'],
      cwd: '/workspace/task',
      environment: { CODEX_HOME: '/attempt/home' },
    });
    expect(JSON.stringify(launch)).not.toContain('.codex');
  });

  it('normalizes result output', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    expect(driver.parseResult({ exitCode: 0, stdout: 'done\n', stderr: '' }))
      .toEqual({ success: true, output: 'done' });
    expect(driver.parseResult({ exitCode: 2, stdout: '', stderr: 'failed' }))
      .toEqual({ success: false, output: '', error: 'failed' });
  });

  it('materializes CODEX_HOME under the supplied attempts root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-codex-driver-'));
    try {
      const driver = new CodexCliDriver({ probeCommand: vi.fn() });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'codex-engineering',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: root,
      });

      expect(home.environment).toEqual({ CODEX_HOME: home.homePath });
      expect(await stat(home.homePath)).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
