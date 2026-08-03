import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'metaclaw-smoke-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

async function loadSmokeScript() {
  return import('../../scripts/smoke-metaclaw-real-task.mjs');
}

describe('smoke-metaclaw-real-task helpers', () => {
  it('parses executor, scenario, and integer options', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.readOption(['--executor', 'pi'], '--executor')).toBe('pi');
    expect(smoke.readOption(['--scenario=python-hello'], '--scenario')).toBe('python-hello');
    expect(smoke.parseExecutorCommand('pi')).toBe('pi');
    expect(smoke.parseScenario('planner-session')).toBe('planner-session');
    expect(smoke.parseScenario('python-hello')).toBe('python-hello');
    expect(smoke.parsePositiveInteger('42', 10)).toBe(42);
    expect(() => smoke.parseExecutorCommand('pi;rm')).toThrow(/Invalid smoke executor command/);
    expect(() => smoke.parseScenario('unknown')).toThrow(/Invalid smoke scenario/);
  });

  it('installs Pi config under the provided executor home', async () => {
    const smoke = await loadSmokeScript();
    const sourceDir = join(tempRoot, 'pi-config');
    const targetHome = join(tempRoot, 'home');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'models.json'), '{"models":[]}');
    writeFileSync(join(sourceDir, 'settings.json'), '{"defaultModel":"test"}');

    const targetDir = smoke.installPiConfig({ sourceDir, targetHome, repoRoot: tempRoot });

    expect(targetDir).toBe(join(targetHome, '.pi', 'agent'));
    expect(existsSync(join(targetDir, 'models.json'))).toBe(true);
    expect(readFileSync(join(targetDir, 'settings.json'), 'utf-8')).toContain('defaultModel');
  });

  it('finds Python hello-world evidence independently of executor output', async () => {
    const smoke = await loadSmokeScript();
    const workdir = join(tempRoot, 'work');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'hello_world.py'), 'print("hello world")\n');

    expect(smoke.findPythonHelloFile(workdir)).toBe(join(workdir, 'hello_world.py'));
  });

  it('verifies Python hello artifacts stored below the managed MetaClaw home', async () => {
    const smoke = await loadSmokeScript();
    const metaclawHome = join(tempRoot, 'managed-home');
    const artifactDir = join(metaclawHome, 'workspace-store', 'workspaces', 'task', 'files');
    const workdir = join(tempRoot, 'empty-workdir');
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(artifactDir, 'hello_world.py'), 'print("hello world")\n');

    expect(smoke.verifyPythonHelloScenario({ workdir, metaclawHome }))
      .toMatchObject({ artifactPath: join(artifactDir, 'hello_world.py') });
  });

  it('extracts the artifact path from the Executor markdown-link result', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.extractArtifactPath('绝对路径：[smoke-result.md](/tmp/smoke-result.md)'))
      .toBe('/tmp/smoke-result.md');
    expect(smoke.extractArtifactPath('已创建文件：`/tmp/smoke-result.md`'))
      .toBe('/tmp/smoke-result.md');
  });

  it('directs artifact output to the runtime-authorized target instead of the process cwd', async () => {
    const smoke = await loadSmokeScript();
    const script = smoke.buildScenarioScript('artifact');

    expect(script).toContain('Runtime will provide the exact authorized target directory');
    expect(script).toContain('do not ask me for a path');
    expect(script).not.toContain('in the current directory');
  });

  it('uses exactly two dialogue turns for the native Planner session memory smoke', async () => {
    const smoke = await loadSmokeScript();
    const script = smoke.buildScenarioScript('planner-session');
    const turns = script.trim().split('\n');

    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain(smoke.plannerMemoryMarker);
    expect(turns[1]).not.toContain(smoke.plannerMemoryMarker);
    expect(turns[1]).toContain('刚才');
    expect(turns[2]).toBe('/exit');
  });

  it('keeps the Python hello requirements in one Planner turn', async () => {
    const smoke = await loadSmokeScript();
    const turns = smoke.buildScenarioScript('python-hello').trim().split('\n');

    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain('hello_world.py');
    expect(turns[0]).toContain('print("hello world")');
    expect(turns[0]).toContain('Run the file with python3');
    expect(turns[1]).toBe('/exit');
  });

  it('requires the second reply to recall the marker from one persisted AnyFusion-Pi session', async () => {
    const smoke = await loadSmokeScript();

    expect(smoke.verifyPlannerSessionScenario({
      interactions: [{
        userInput: '刚才的测试短语是什么？只回复短语。',
        systemOutput: smoke.plannerMemoryMarker,
      }],
      sessionFiles: ['/planner/sessions/2026/07/30/rollout-one.jsonl'],
    })).toEqual({
      nativeSessionPath: '/planner/sessions/2026/07/30/rollout-one.jsonl',
    });

    expect(() => smoke.verifyPlannerSessionScenario({
      interactions: [{ userInput: '刚才的测试短语是什么？', systemOutput: '不知道' }],
      sessionFiles: ['/planner/sessions/one.jsonl'],
    })).toThrow(/did not recall/);
    expect(() => smoke.verifyPlannerSessionScenario({
      interactions: [{ userInput: '刚才的测试短语是什么？', systemOutput: smoke.plannerMemoryMarker }],
      sessionFiles: ['/planner/sessions/one.jsonl', '/planner/sessions/two.jsonl'],
    })).toThrow(/exactly one persisted AnyFusion-Pi session/);
  });
});
