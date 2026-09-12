import { describe, expect, it } from 'vitest';
import { buildPlannerScopedConfiguration, keepActivePlanner } from '../../web/src/planner-update';
import { classifyConfigurationDiff } from '../../src/configuration/configuration-diff.js';

function activeConfig(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    providers: {
      provider: { baseUrl: 'https://code.example/v1', apiKeyRef: 'file-secret:anyfusion/provider' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyRef: 'file-secret:anyfusion/providers/deepseek' },
    },
    models: {
      'default-model': { modelId: 'gpt-5.6-sol', providerRef: 'provider', capabilities: ['planning'] },
      'deepseek-v4-pro': { modelId: 'deepseek-v4-pro', providerRef: 'deepseek', capabilities: [] },
    },
    agentClasses: {
      planner: { kind: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'default-model' } },
      'codex-engineering': { kind: 'executor', modelPolicy: { mode: 'fixed', modelRef: 'default-model' } },
    },
    runtimePolicy: { maxConcurrentTasks: 2 },
  };
}

describe('keepActivePlanner', () => {
  it('keeps the running planner while applying other agent-class edits', () => {
    const active = activeConfig();
    const candidate = {
      ...active,
      agentClasses: {
        ...(active.agentClasses as Record<string, unknown>),
        // 草稿里 Planner 被改过，但常规保存不应提交它
        planner: { kind: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'deepseek-v4-pro' } },
        'codex-engineering': { kind: 'executor', modelPolicy: { mode: 'auto', allowedModelRefs: ['deepseek-v4-pro'] } },
      },
    };

    const merged = keepActivePlanner({ activeConfig: active, candidateConfig: candidate });
    const agentClasses = merged.agentClasses as Record<string, Record<string, unknown>>;

    expect(agentClasses.planner).toEqual(
      (active.agentClasses as Record<string, Record<string, unknown>>).planner,
    );
    expect((agentClasses['codex-engineering'].modelPolicy as Record<string, unknown>).mode).toBe('auto');
  });

  it('never drops the planner entry (dropping it would look like a restart-required change)', () => {
    const active = activeConfig();
    const candidateWithoutPlanner = {
      ...active,
      agentClasses: { 'codex-engineering': { kind: 'executor' } },
    };

    const merged = keepActivePlanner({
      activeConfig: active,
      candidateConfig: candidateWithoutPlanner,
    });

    expect((merged.agentClasses as Record<string, unknown>).planner).toBeDefined();
  });

  it('produces a hot-only diff for executor edits on top of the running planner', () => {
    const active = activeConfig();
    const candidate = {
      ...active,
      models: {
        ...(active.models as Record<string, unknown>),
        'deepseek-v4-pro': { modelId: 'deepseek-v4-pro', providerRef: 'deepseek', capabilities: ['planning', 'structured-output'] },
      },
      agentClasses: {
        ...(active.agentClasses as Record<string, unknown>),
        planner: { kind: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'deepseek-v4-pro' } },
        'codex-engineering': { kind: 'executor', modelPolicy: { mode: 'auto', allowedModelRefs: ['default-model'] } },
      },
    };

    const merged = keepActivePlanner({ activeConfig: active, candidateConfig: candidate });
    const classification = classifyConfigurationDiff(active, merged);

    // 常规保存不应再报 “此更改需要重启服务后生效：agentClasses.planner”
    expect(classification.restartPaths).toEqual([]);
    expect(classification.classification).toBe('hot');

    // 反证：若像旧实现那样直接丢掉 planner，就会被判为进程级变更
    const dropped = classifyConfigurationDiff(active, {
      ...candidate,
      agentClasses: { 'codex-engineering': (candidate.agentClasses as Record<string, unknown>)['codex-engineering'] },
    });
    expect(dropped.classification).toBe('restart_required');
    expect(dropped.restartPaths).toContain('agentClasses.planner');
  });

  it('leaves the candidate untouched when the active config has no planner', () => {
    const candidate = { agentClasses: { planner: { kind: 'planner' } } };
    expect(keepActivePlanner({ activeConfig: {}, candidateConfig: candidate })).toBe(candidate);
  });
});

describe('buildPlannerScopedConfiguration', () => {
  it('applies only the planner binding plus its model/provider prerequisites', () => {
    const active = activeConfig();
    const candidate = {
      ...active,
      providers: {
        ...(active.providers as Record<string, unknown>),
        kimi: { baseUrl: 'https://api.kimi.com/coding/v1', apiKeyRef: 'file-secret:anyfusion/providers/kimi' },
      },
      models: {
        ...(active.models as Record<string, unknown>),
        'pi-research-7': { modelId: 'k3', providerRef: 'kimi', capabilities: ['coding'] },
      },
      agentClasses: {
        ...(active.agentClasses as Record<string, unknown>),
        planner: { kind: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'pi-research-7' } },
        // 未被保存的 Executor 编辑：不应出现在 Planner 更新里
        'codex-engineering': { kind: 'executor', modelPolicy: { mode: 'fixed', modelRef: 'pi-research-7' } },
      },
      runtimePolicy: { maxConcurrentTasks: 7 },
    };

    const scoped = buildPlannerScopedConfiguration({
      activeConfig: active,
      candidateConfig: candidate,
      candidateSecrets: { kimi: 'sk-kimi', deepseek: 'sk-deepseek' },
    });

    const agentClasses = scoped.config.agentClasses as Record<string, Record<string, unknown>>;
    expect((agentClasses.planner.modelPolicy as Record<string, unknown>).modelRef).toBe('pi-research-7');
    // Executor 保持运行中配置，不被 Planner 更新顺带改写
    expect(agentClasses['codex-engineering']).toEqual(
      (active.agentClasses as Record<string, Record<string, unknown>>)['codex-engineering'],
    );
    // 运行时策略不在 Planner 作用域内
    expect(scoped.config.runtimePolicy).toEqual({ maxConcurrentTasks: 2 });
    // 只带上 Planner 依赖的 Model 与 Provider
    const models = scoped.config.models as Record<string, unknown>;
    expect(Object.keys(models).sort()).toEqual([
      'deepseek-v4-pro',
      'default-model',
      'pi-research-7',
    ]);
    const providers = scoped.config.providers as Record<string, unknown>;
    expect(Object.keys(providers).sort()).toEqual(['deepseek', 'kimi', 'provider']);
    // 密钥只提交 Planner 依赖 Provider 的
    expect(scoped.activationSecrets).toEqual({ kimi: 'sk-kimi' });
  });

  it('keeps planner prerequisites when the active config already contains them', () => {
    const active = activeConfig();
    const candidate = {
      ...active,
      agentClasses: {
        ...(active.agentClasses as Record<string, unknown>),
        planner: { kind: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'deepseek-v4-pro' } },
      },
    };

    const scoped = buildPlannerScopedConfiguration({
      activeConfig: active,
      candidateConfig: candidate,
    });

    const agentClasses = scoped.config.agentClasses as Record<string, Record<string, unknown>>;
    expect((agentClasses.planner.modelPolicy as Record<string, unknown>).modelRef).toBe('deepseek-v4-pro');
    expect((scoped.config.models as Record<string, unknown>)['deepseek-v4-pro']).toBeDefined();
    expect(scoped.activationSecrets).toEqual({});
  });

  it('fails closed when the candidate has no planner entry', () => {
    expect(() => buildPlannerScopedConfiguration({
      activeConfig: activeConfig(),
      candidateConfig: { ...activeConfig(), agentClasses: {} },
    })).toThrow('Planner 配置不可用');
  });
});
