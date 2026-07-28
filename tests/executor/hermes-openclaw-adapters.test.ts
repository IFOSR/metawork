import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeepSeekTuiAdapter } from '../../src/executor/deepseek-tui.js';
import { HermesAgentAdapter } from '../../src/executor/hermes-agent.js';
import { OpenClawAdapter } from '../../src/executor/openclaw.js';
import { PiAgentAdapter } from '../../src/executor/pi-agent.js';
import { CustomCliExecutorAdapter } from '../../src/executor/custom-cli.js';

describe('HermesAgentAdapter', () => {
  it('uses hermes headless mode with approvals and hooks bypassed', () => {
    const adapter = new HermesAgentAdapter({ command: 'hermes', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['--oneshot', 'test prompt', '--yolo', '--accept-hooks']);
  });
});

describe('OpenClawAdapter', () => {
  it('uses openclaw local agent json mode', () => {
    const adapter = new OpenClawAdapter({ command: 'openclaw', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['agent', '--message', 'test prompt', '--local', '--json']);
  });
});

describe('DeepSeekTuiAdapter', () => {
  it('uses deepseek-tui non-interactive auto exec mode', () => {
    const adapter = new DeepSeekTuiAdapter({ command: 'deepseek-tui', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(['exec', '--auto', 'test prompt']);
  });
});

describe('PiAgentAdapter', () => {
  it('uses pi prompt mode with Metaclaw web search tools enabled for non-interactive execution', () => {
    const adapter = new PiAgentAdapter({ command: 'pi', timeout: 300 });
    const args = (adapter as any).buildSpawnArgs('test prompt');

    expect(args).toEqual(expect.arrayContaining([
      '--no-extensions',
      '--extension',
      '--tools',
      'web_search,web_fetch,evidence_list,evidence_search,evidence_get,bash,read,write,edit,grep,find,ls',
      '--append-system-prompt',
      '-p',
      'test prompt',
    ]));
    expect(args[args.indexOf('--extension') + 1]).toContain('metaclaw-web-tools.ts');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('Use web_search automatically');
  });

  it('loads the Executor Pi provider env file with precedence over inherited values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'metaclaw-pi-env-'));
    const envFile = join(directory, 'executor-pi.env');
    writeFileSync(envFile, 'OPENAI_API_KEY=pi-file-key\nOPENAI_BASE_URL=https://pi.invalid/v1\n');
    vi.stubEnv('METACLAW_PI_EXECUTOR_ENV_FILE', envFile);
    vi.stubEnv('OPENAI_API_KEY', 'inherited-key');

    try {
      const adapter = new PiAgentAdapter({ command: 'pi', timeout: 300 });
      const env = (adapter as any).buildSpawnEnv();
      expect(env.OPENAI_API_KEY).toBe('pi-file-key');
      expect(env.OPENAI_BASE_URL).toBe('https://pi.invalid/v1');
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CustomCliExecutorAdapter', () => {
  it('replaces the prompt placeholder in configured non-interactive args', () => {
    const adapter = new CustomCliExecutorAdapter({
      name: 'research-bot',
      command: 'research-bot',
      args: ['run', '--prompt', '{prompt}'],
      timeout: 300,
    });

    expect((adapter as any).buildSpawnArgs('test prompt')).toEqual(['run', '--prompt', 'test prompt']);
  });

  it('appends the prompt when args do not contain a prompt placeholder', () => {
    const adapter = new CustomCliExecutorAdapter({
      name: 'research-bot',
      command: 'research-bot',
      args: ['run'],
      timeout: 300,
    });

    expect((adapter as any).buildSpawnArgs('test prompt')).toEqual(['run', 'test prompt']);
  });

  it('uses the configured shell check command for availability', async () => {
    const adapter = new CustomCliExecutorAdapter({
      name: 'research-bot',
      command: 'missing-research-bot',
      args: [],
      checkCommand: 'node --version',
      timeout: 300,
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
  });
});
