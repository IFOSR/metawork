import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      args: [
        'exec',
        '--json',
        '--sandbox', 'danger-full-access',
        '-c', 'approval_policy="never"',
        '--skip-git-repo-check',
        '--ephemeral',
        '--color', 'never',
        'implement change',
      ],
      cwd: '/workspace/task',
      environment: { CODEX_HOME: '/attempt/home' },
    });
    expect(JSON.stringify(launch)).not.toContain('.codex');
  });

  it('routes the authorized model and provider into the codex invocation', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    const launch = driver.buildLaunch({
      prompt: 'implement change',
      cwd: '/workspace/task',
      runtimeHomePath: '/attempt/home',
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
    });

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--sandbox', 'danger-full-access',
      '-c', 'model="gpt-5.6-sol"',
      '-c', 'model_provider="code-cli"',
      '-c', 'approval_policy="never"',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      'implement change',
    ]);
  });

  it('builds a response-only launch in a read-only sandbox', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    const launch = driver.buildLaunch({
      prompt: 'return completion metadata only',
      cwd: '/attempt/home',
      runtimeHomePath: '/attempt/home',
      providerRef: 'code-cli',
      modelId: 'gpt-5.6-sol',
      responseOnly: true,
    });

    expect(driver.supportsResponseOnly).toBe(true);
    expect(launch.args).toContain('read-only');
    expect(launch.args).not.toContain('workspace-write');
    expect(launch.args).not.toContain('danger-full-access');
  });

  it('normalizes result output', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    expect(driver.parseResult({ exitCode: 0, stdout: 'done\n', stderr: '' }))
      .toEqual({ success: true, output: 'done' });
    expect(driver.parseResult({ exitCode: 2, stdout: '', stderr: 'failed' }))
      .toEqual({ success: false, output: '', error: 'failed' });
  });

  it('extracts JSONL agent output and streams sanitized execution activity', () => {
    const driver = new CodexCliDriver({ probeCommand: vi.fn() });
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-secret' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'reasoning', text: 'private reasoning' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_2', type: 'command_execution', command: 'cat secret.txt' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_4', type: 'mcp_tool_call', tool: 'fetch_page', arguments: { url: 'https://example.test/report' } },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_3', type: 'agent_message', text: 'Implemented safely' },
      }),
    ].join('\n');

    expect(driver.parseResult({ exitCode: 0, stdout, stderr: '' })).toEqual({
      success: true,
      output: 'Implemented safely',
    });
    expect((driver as CodexCliDriver & {
      parseResultLine?(input: { stream: 'stdout' | 'stderr'; line: string }): string | null;
    }).parseResultLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Implemented safely' },
      }),
    })).toBe('Implemented safely');
    // 隐藏思维链内容不透出，但"正在推理"里程碑会流出。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'item.started',
        item: { type: 'reasoning', text: 'must not appear' },
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor is reasoning through the next step',
    });
    // 工作区命令带脱敏后的命令摘录。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', command: 'cat secret.txt' },
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor started workspace command: cat secret.txt',
    });
    // MCP 工具带工具名与白名单参数摘要。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'item.started',
        item: { type: 'mcp_tool_call', tool: 'fetch_page', arguments: { url: 'https://example.test/report', secret: 'x' } },
      }),
    })).toEqual({
      kind: 'skill',
      text: 'Executor started MCP tool: fetch_page — https://example.test/report',
    });
    // 助手叙述脱敏后流出。
    expect(driver.parseProgressLine?.({
      stream: 'stdout',
      line: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Implemented safely' },
      }),
    })).toEqual({
      kind: 'status',
      text: 'Executor: Implemented safely',
    });
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
        environment: {},
      });

      expect(home.environment).toEqual({ CODEX_HOME: home.homePath });
      expect(await stat(home.homePath)).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('seeds the attempt home with the rewritten provider config and runtime credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-codex-driver-'));
    try {
      const templateDir = join(root, 'codex-template');
      await mkdir(templateDir, { recursive: true });
      await writeFile(join(templateDir, 'config.toml'), 'base_url = "https://provider.test/v1"\n');

      const driver = new CodexCliDriver({
        probeCommand: vi.fn(),
        homeTemplateDir: templateDir,
      });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'codex-engineering',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {
          OPENAI_API_KEY: 'sk-test',
          OPENAI_BASE_URL: 'https://provider.test/v1',
        },
      });

      expect(await readFile(join(home.homePath, 'config.toml'), 'utf8'))
        .toContain('https://provider.test/v1');
      expect(home.environment).toEqual({
        CODEX_HOME: home.homePath,
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://provider.test/v1',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the assigned template is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-codex-driver-'));
    try {
      const missingTemplate = new CodexCliDriver({
        probeCommand: vi.fn(),
        homeTemplateDir: join(root, 'missing-template'),
      });
      await expect(missingTemplate.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'codex-engineering',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      })).rejects.toThrow(/missing config\.toml/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers the generated agent-runtime home over the legacy env var', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-codex-priority-'));
    const generatedRoot = join(root, 'generated', 'agent-runtime');
    const codexDir = join(generatedRoot, 'revision-current', 'codex');
    const legacyDir = join(root, 'legacy-codex');
    try {
      await mkdir(codexDir, { recursive: true });
      await writeFile(join(generatedRoot, 'current'), 'revision-current\n');
      await writeFile(join(codexDir, 'config.toml'), 'base_url = "https://generated.test/v1"\n');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, 'config.toml'), 'base_url = "https://legacy.test/v1"\n');

      vi.stubEnv('ANYFUSION_INSTALL_ROOT', root);
      vi.stubEnv('METACLAW_EXECUTOR_CODEX_HOME', legacyDir);

      const driver = new CodexCliDriver({ probeCommand: vi.fn() });
      const home = await driver.materializeHome({
        attemptId: 'attempt-1',
        revisionId: 'revision-1',
        agentClassId: 'codex-engineering',
        bindingFingerprint: 'fingerprint',
        attemptsRoot: join(root, 'attempts'),
        environment: {},
      });

      expect(await readFile(join(home.homePath, 'config.toml'), 'utf8'))
        .toContain('https://generated.test/v1');
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
