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
        '--sandbox', 'workspace-write',
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
});
