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
      args: ['--mode', 'json', 'research current information'],
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

  it('extracts the final assistant answer and only exposes safe lifecycle progress', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const stdout = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'turn_start', turnIndex: 0 }),
      JSON.stringify({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hidden reasoning text' }] },
      }),
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'tool_1',
        toolName: 'web_search',
        args: { query: 'sensitive query value' },
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final research answer' }],
        },
      }),
    ].join('\n');

    expect(driver.parseResult({ exitCode: 0, stdout, stderr: '' })).toEqual({
      success: true,
      output: 'Final research answer',
    });
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({ type: 'message_update', message: { role: 'assistant' } }),
    })).toBeNull();
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'tool_execution_start',
        toolName: 'web_search',
        args: { query: 'must not appear' },
      }),
    })).toEqual({
      kind: 'skill',
      text: 'Executor started tool: web_search',
    });
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
        environment: {},
      });

      expect(await stat(home.environment.PI_CODING_AGENT_SESSION_DIR)).toBeTruthy();
      expect(home.environment.HOME).toBe(home.homePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('seeds the attempt home with the provider models and runtime credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-driver-'));
    try {
      const templateDir = join(root, 'pi-home');
      await mkdir(join(templateDir, '.pi', 'agent'), { recursive: true });
      await writeFile(join(templateDir, '.pi', 'agent', 'models.json'), '{"providers":{}}\n');
      await writeFile(join(templateDir, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"anyint"}\n');

      const driver = new PiCliDriver({
        probeCommand: vi.fn(),
        homeTemplateDir: templateDir,
      });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: { OPENAI_API_KEY: 'sk-test', PI_TELEMETRY: '0' },
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

  it('fails closed when the assigned template is missing', async () => {
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
        environment: {},
      })).rejects.toThrow(/missing models\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers the generated agent-runtime home over the legacy env var', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-priority-'));
    const generatedRoot = join(root, 'generated', 'agent-runtime');
    const piHomeDir = join(generatedRoot, 'revision-current', 'pi-home');
    const legacyDir = join(root, 'legacy-pi-home');
    try {
      await mkdir(join(piHomeDir, '.pi', 'agent'), { recursive: true });
      await writeFile(join(generatedRoot, 'current'), 'revision-current\n');
      await writeFile(join(piHomeDir, '.pi', 'agent', 'models.json'), '{"providers":{"generated":{}}}\n');
      await writeFile(join(piHomeDir, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"generated"}\n');
      await mkdir(join(legacyDir, '.pi', 'agent'), { recursive: true });
      await writeFile(join(legacyDir, '.pi', 'agent', 'models.json'), '{"providers":{"legacy":{}}}\n');
      await writeFile(join(legacyDir, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"legacy"}\n');

      vi.stubEnv('ANYFUSION_INSTALL_ROOT', root);
      vi.stubEnv('METACLAW_EXECUTOR_PI_HOME', legacyDir);

      const driver = new PiCliDriver({ probeCommand: vi.fn() });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });

      const agentDir = join(home.homePath, '.pi', 'agent');
      expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toContain('generated');
      expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toContain('generated');
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
