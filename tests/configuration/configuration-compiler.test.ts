import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationCompiler } from '../../src/configuration/configuration-compiler.js';
import { buildPlannerConfigurationView } from '../../src/configuration/projections.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeImmutableTree));
});

function snapshot(): ConfigurationSnapshot {
  const config = AnyFusionConfigurationV2Schema.parse({
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/openai',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      engineering: {
        providerRef: 'openai',
        modelId: 'engineering-model',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        routingNotes: {
          summary: '适合工程实现。',
          strengths: ['代码重构'],
        },
        enabled: true,
      },
      review: {
        providerRef: 'openai',
        modelId: 'review-model',
        capabilities: ['coding', 'structured-output'],
        reasoning: 'high',
        enabled: true,
      },
      image: {
        providerRef: 'openai',
        modelId: 'gpt-image-2',
        capabilities: ['vision'],
        reasoning: 'disabled',
        enabled: true,
      },
    },
    harnesses: {
      planner: {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'engineering-local': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: ['exec'],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      pi: {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: ['-p'],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      'planner-default': {
        kind: 'planner',
        harnessRef: 'planner',
        modelPolicy: { mode: 'fixed', modelRef: 'review' },
        generatedRuntimeRef: 'planner-default',
        enabled: true,
      },
      'codex-engineering': {
        kind: 'executor',
        harnessRef: 'engineering-local',
        modelPolicy: {
          mode: 'auto',
          allowedModelRefs: ['engineering', 'image'],
          defaultModelRef: 'engineering',
        },
        permissionProfileRef: 'workspace-default',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['implementation'],
        avoidUseCases: [],
        executorManual: {
          sourceText: '优先处理 monorepo 重构。',
          assertions: [{ topic: 'preferred-task', text: '优先处理 monorepo 重构.' }],
        },
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        generatedRuntimeRef: 'codex-engineering',
        enabled: true,
      },
      'codex-review': {
        kind: 'executor',
        harnessRef: 'engineering-local',
        modelPolicy: { mode: 'fixed', modelRef: 'review' },
        permissionProfileRef: 'workspace-default',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['review'],
        avoidUseCases: [],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        generatedRuntimeRef: 'codex-review',
        enabled: true,
      },
      'pi-research': {
        kind: 'executor',
        harnessRef: 'pi',
        modelPolicy: { mode: 'fixed', modelRef: 'review' },
        permissionProfileRef: 'public-web',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['research'],
        avoidUseCases: [],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        generatedRuntimeRef: 'pi-research',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-default': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {},
      },
      'public-web': {
        profileId: 'public-web-research',
        version: 1,
        parameters: { allowedPublicDomains: ['example.com'] },
      },
    },
    runtimePolicy: {},
    gateway: {},
  });
  return { revisionId: 'revision-1', contentHash: 'sha256:config', config };
}

describe('ConfigurationCompiler', () => {
  it('generates isolated AgentClass runtime directories under one revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-runtime-compiler-'));
    roots.push(root);
    const compiler = new ConfigurationCompiler(root);

    const result = await compiler.compile(snapshot());

    expect(result.rootPath).toBe(join(root, 'revision-1'));
    expect(await readFile(join(result.rootPath, 'planner', 'models.json'), 'utf8'))
      .toContain('"engineering-model"');
    expect(await readFile(join(result.rootPath, 'planner', 'settings.json'), 'utf8'))
      .toContain('"review-model"');
    for (const relativePath of [
      'planner/planner-default',
      'executors/codex-engineering',
      'executors/codex-review',
      'executors/pi-research',
    ]) {
      expect(await stat(join(result.rootPath, relativePath))).toBeTruthy();
    }
    expect(await readFile(join(result.rootPath, 'executors/codex-engineering', 'model.json'), 'utf8'))
      .not.toContain('apiKeyRef');
    expect(await readFile(join(result.rootPath, 'executors/codex-engineering', 'model.json'), 'utf8'))
      .not.toContain('https://');
    expect(await readFile(join(result.rootPath, 'executors/codex-engineering', 'model.json'), 'utf8'))
      .not.toEqual(await readFile(join(result.rootPath, 'executors/codex-review', 'model.json'), 'utf8'));
    expect(await readFile(join(result.rootPath, 'executors/codex-engineering', 'CAPABILITY.md'), 'utf8'))
      .toContain('优先处理 monorepo 重构.');
    expect(await readFile(join(result.rootPath, 'executors/codex-engineering', 'CAPABILITY.md'), 'utf8'))
      .toContain('engineering-model');
    const plannerManual = buildPlannerConfigurationView(snapshot())
      .executorCapabilityManuals?.find(manual => manual.agentClassRef === 'codex-engineering');
    expect(await readFile(
      join(result.rootPath, 'executors/codex-engineering', 'CAPABILITY.md'),
      'utf8',
    )).toBe(plannerManual?.markdown);
    expect(await readFile(join(result.rootPath, 'executors/codex-review', 'CAPABILITY.md'), 'utf8'))
      .not.toContain('优先处理 monorepo 重构.');
    expect((await stat(result.rootPath)).mode & 0o777).toBe(0o555);
  });
});

async function removeImmutableTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}
