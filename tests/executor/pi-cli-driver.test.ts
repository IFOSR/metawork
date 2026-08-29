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
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });

    expect(launch).toEqual({
      command: 'pi',
      args: [
        '--mode',
        'json',
        '--provider',
        'deepseek',
        '--model',
        'deepseek-v4-pro',
        'research current information',
      ],
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

  it('fails closed when Pi reports a structured model error with exit code zero', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const stdout = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'OpenAI API error (401): invalid_authentication_error token=sk-secret',
        },
      }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'OpenAI API error (401): invalid_authentication_error token=sk-secret',
        }],
        willRetry: false,
      }),
    ].join('\n');

    expect(driver.parseResult({ exitCode: 0, stdout, stderr: '' })).toEqual({
      success: false,
      output: '',
      error: 'OpenAI API error (401): invalid_authentication_error token=[REDACTED]',
    });
  });

  it('preserves a final assistant body when Pi fails after producing partial output', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const stdout = [
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial answer before timeout' }],
        },
      }),
      JSON.stringify({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial answer before timeout' }],
          stopReason: 'error',
          errorMessage: 'request timed out',
        }],
      }),
    ].join('\n');

    expect(driver.parseResult({ exitCode: 1, stdout, stderr: '' })).toEqual({
      success: false,
      output: 'Partial answer before timeout',
      error: 'request timed out',
    });
  });

  it('fails closed when Pi exits zero without a final assistant answer', () => {
    const driver = new PiCliDriver({ probeCommand: vi.fn() });
    const stdout = [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'agent_end', messages: [], willRetry: false }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n');

    expect(driver.parseResult({ exitCode: 0, stdout, stderr: '' })).toEqual({
      success: false,
      output: '',
      error: 'Pi executor exited without a final assistant response',
    });
  });

  it('extracts the final assistant answer and streams sanitized execution activity', () => {
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
        type: 'tool_execution_end',
        toolCallId: 'tool_1',
        toolName: 'read',
        isError: false,
        args: { path: '/workspace/report.md' },
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
    expect((driver as PiCliDriver & {
      parseResultLine?(input: { stream: 'stdout' | 'stderr'; line: string }): string | null;
    }).parseResultLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final research answer' }],
        },
      }),
    })).toBe('Final research answer');
    // message_update（逐 token 增量）不进入进度流，message_end 才呈现。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({ type: 'message_update', message: { role: 'assistant' } }),
    })).toBeNull();
    // 工具活动带白名单参数摘要，实时呈现给用户。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'tool_execution_start',
        toolName: 'web_search',
        args: { query: 'sensitive query value', secret: 'must not appear' },
      }),
    })).toEqual({
      kind: 'skill',
      text: 'Executor started tool: web_search — sensitive query value',
    });
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'read',
        isError: false,
        args: { path: '/workspace/report.md' },
      }),
    })).toEqual({
      kind: 'skill',
      text: 'Executor completed tool: read — /workspace/report.md',
    });
    // 助手叙述（执行思路）脱敏后实时流出。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我先检查最近的公告，再对比同行业估值。\n\n第二步验证资金流向。' }],
        },
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor: 我先检查最近的公告，再对比同行业估值。 第二步验证资金流向。',
    });
    // 非 assistant 的 message_end 不产生进度。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_end',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'raw tool output' }] },
      }),
    })).toBeNull();
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'message_start',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'must not appear' }],
        },
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor model response stream started',
    });
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'must not appear' }],
        },
        toolResults: [{ content: 'must not appear' }],
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor processing cycle completed',
    });
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({ type: 'agent_settled', secret: 'must not appear' }),
    })).toEqual({
      kind: 'status',
      text: 'Executor process settled',
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

  it('installs the web extension only for a Pi AgentClass with web affordances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-web-extension-'));
    try {
      const extensionSource = join(root, 'pi-attempt-tools.ts');
      await writeFile(extensionSource, 'export const testExtension = true;\n');
      const driver = new PiCliDriver({
        probeCommand: vi.fn(),
        webExtensionSourcePath: extensionSource,
      });

      const researchHome = await driver.materializeHome({
        attemptId: 'research-attempt',
        revisionId: 'revision-1',
        agentClassId: 'pi-agent',
        executorAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });
      expect(await readFile(
        join(researchHome.homePath, '.pi', 'agent', 'extensions', 'metawork-web-tools.ts'),
        'utf8',
      )).toContain('testExtension');

      const ordinaryHome = await driver.materializeHome({
        attemptId: 'ordinary-attempt',
        revisionId: 'revision-1',
        agentClassId: 'pi-agent',
        executorAffordances: [],
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });
      await expect(stat(
        join(ordinaryHome.homePath, '.pi', 'agent', 'extensions', 'metawork-web-tools.ts'),
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the built web extension from the active install root when env is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-install-root-'));
    try {
      const extensionSource = join(root, 'app', 'current', 'dist', 'pi-attempt-tools.ts');
      await mkdir(join(root, 'app', 'current', 'dist'), { recursive: true });
      await writeFile(extensionSource, 'export const installedExtension = true;\n');
      vi.stubEnv('METAWORK_INSTALL_ROOT', root);
      vi.stubEnv('ANYFUSION_INSTALL_ROOT', root);

      const driver = new PiCliDriver({ probeCommand: vi.fn() });
      const home = await driver.materializeHome({
        attemptId: 'research-attempt',
        revisionId: 'revision-1',
        agentClassId: 'pi-research',
        executorAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });

      expect(await readFile(
        join(home.homePath, '.pi', 'agent', 'extensions', 'metawork-web-tools.ts'),
        'utf8',
      )).toContain('installedExtension');
    } finally {
      vi.unstubAllEnvs();
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

  it('materializes the exact authorized revision instead of a legacy Pi home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-pi-revision-'));
    const generatedRoot = join(root, 'generated', 'agent-runtime');
    const revisionDir = join(generatedRoot, 'revision-authorized', 'pi-home');
    const legacyDir = join(root, 'legacy-pi-home');
    try {
      await mkdir(join(revisionDir, '.pi', 'agent'), { recursive: true });
      await writeFile(
        join(revisionDir, '.pi', 'agent', 'models.json'),
        '{"providers":{"deepseek":{}}}\n',
      );
      await writeFile(
        join(revisionDir, '.pi', 'agent', 'settings.json'),
        '{"defaultProvider":"deepseek","defaultModel":"deepseek-v4-pro"}\n',
      );
      await mkdir(join(legacyDir, '.pi', 'agent'), { recursive: true });
      await writeFile(
        join(legacyDir, '.pi', 'agent', 'models.json'),
        '{"providers":{"kimi":{}}}\n',
      );
      await writeFile(
        join(legacyDir, '.pi', 'agent', 'settings.json'),
        '{"defaultProvider":"kimi","defaultModel":"k3"}\n',
      );
      vi.stubEnv('METACLAW_EXECUTOR_PI_HOME', legacyDir);

      const driver = new PiCliDriver({
        probeCommand: vi.fn(),
        generatedRuntimeRoot: generatedRoot,
      });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-authorized',
        agentClassId: 'pi-agent',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });

      const agentDir = join(home.homePath, '.pi', 'agent');
      expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toContain('deepseek');
      expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toContain('deepseek-v4-pro');
      expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).not.toContain('kimi');
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
