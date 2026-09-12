function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 常规保存（「保存并激活」）不修改 Planner：用当前运行中的 Planner 原样覆盖
 * 候选配置里的 Planner。
 *
 * 注意必须是「覆盖」而不是「删除」：若提交的配置里缺少 `agentClasses.planner`，
 * 服务端会把 Planner 结构的消失归类为进程级变更（restart_required），
 * 从而误报「需要重启服务后生效」。
 */
export function keepActivePlanner(input: {
  activeConfig: Record<string, unknown>;
  candidateConfig: Record<string, unknown>;
}): Record<string, unknown> {
  const activePlanner = asRecord(asRecord(input.activeConfig.agentClasses).planner);
  if (Object.keys(activePlanner).length === 0) return input.candidateConfig;
  return {
    ...input.candidateConfig,
    agentClasses: {
      ...asRecord(input.candidateConfig.agentClasses),
      planner: activePlanner,
    },
  };
}

/**
 * 从「完整候选配置」中提取 Planner 更新作用域：
 *
 * - 只应用 `agentClasses.planner`（连同它依赖的 Model 与 Provider）
 * - 其余 AgentClass、运行时策略、以及未被 Planner 引用的模型/Provider
 *   均保持当前运行中配置不变
 *
 * 这样「更新 Planner」就不会顺带用尚未更新的 Planner 改写其它设置；
 * 其它设置仍由常规的「保存并激活」提交。
 */
export function buildPlannerScopedConfiguration(input: {
  /** 当前运行中的配置（服务端返回的原始配置）。 */
  activeConfig: Record<string, unknown>;
  /** 由草稿构建出的完整候选配置。 */
  candidateConfig: Record<string, unknown>;
  /** 完整候选对应的密钥集合；只有 Planner 依赖的 Provider 会被保留。 */
  candidateSecrets?: Record<string, string>;
}): { config: Record<string, unknown>; activationSecrets: Record<string, string> } {
  const plannerEntry = asRecord(asRecord(input.candidateConfig.agentClasses).planner);
  if (Object.keys(plannerEntry).length === 0) {
    throw new Error('Planner 配置不可用');
  }
  const policy = asRecord(plannerEntry.modelPolicy);
  const modelRefs: unknown[] = policy.mode === 'auto'
    ? [
      ...(Array.isArray(policy.allowedModelRefs) ? policy.allowedModelRefs : []),
      ...(typeof policy.defaultModelRef === 'string' ? [policy.defaultModelRef] : []),
    ]
    : (typeof policy.modelRef === 'string' ? [policy.modelRef] : []);

  const candidateModels = asRecord(input.candidateConfig.models);
  const candidateProviders = asRecord(input.candidateConfig.providers);
  const plannerModels = Object.fromEntries(
    [...new Set(modelRefs.filter((ref): ref is string => (
      typeof ref === 'string' && ref.length > 0 && Boolean(candidateModels[ref])
    )))].map(ref => [ref, candidateModels[ref]]),
  );
  const plannerProviderRefs = [...new Set(Object.values(plannerModels)
    .map(model => String(asRecord(model).providerRef ?? ''))
    .filter(Boolean))];
  const plannerProviders = Object.fromEntries(plannerProviderRefs
    .filter(ref => candidateProviders[ref])
    .map(ref => [ref, candidateProviders[ref]]));

  const candidateSecrets = input.candidateSecrets ?? {};
  return {
    config: {
      ...input.activeConfig,
      providers: { ...asRecord(input.activeConfig.providers), ...plannerProviders },
      models: { ...asRecord(input.activeConfig.models), ...plannerModels },
      agentClasses: { ...asRecord(input.activeConfig.agentClasses), planner: plannerEntry },
    },
    activationSecrets: Object.fromEntries(plannerProviderRefs
      .filter(ref => typeof candidateSecrets[ref] === 'string' && candidateSecrets[ref].length > 0)
      .map(ref => [ref, candidateSecrets[ref] as string])),
  };
}
