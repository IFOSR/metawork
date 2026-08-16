import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('seeds the attempt home with the provider models and env-file credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-driver-'));
    try {
      const templateDir = join(root, 'pi-home');
      await mkdir(join(templateDir, '.pi', 'agent'), { recursive: true });
      await writeFile(join(templateDir, '.pi', 'agent', 'models.json'), '{"providers":{}}\n');
      await writeFile(join(templateDir, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"anyint"}\n');
      const envFile = join(root, 'executor-pi.env');
      await writeFile(envFile, 'OPENAI_API_KEY=sk-test\nPI_TELEMETRY=0\n');

      const driver = new PiCliDriver({
        probeCommand: vi.fn(),
        homeTemplateDir: templateDir,
        envFile,
      });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
      });

      const agentDir = join(home.homePath, '.pi', 'agent');
      expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toContain('providers');
      expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toContain('anyint');
      expect(home.environment.OPENAI_API_KEY).toBe('sk-test');
      expect(home.environment.PI_TELEMETRY).toBe('0');
      expect(home.environment.HOME).toBe(home.homePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the assigned template or env file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-driver-'));
    try {
      const missingTemplate = new PiCliDriver({
        probeCommand: vi.fn(),
        homeTemplateDir: join(root, 'missing-template'),
      });
      await expect(missingTemplate.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
      })).rejects.toThrow(/missing models\.json/);

      const missingEnvFile = new PiCliDriver({
        probeCommand: vi.fn(),
        envFile: join(root, 'missing.env'),
      });
      await expect(missingEnvFile.materializeHome({
        attemptId: 'attempt-2',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
      })).rejects.toThrow(/env file does not exist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
