import type { AnyFusionConfigurationV2 } from './types.js';

function enabledModelRefs(configuration: AnyFusionConfigurationV2): Set<string> {
  const modelRefs = new Set<string>();
  for (const agentClass of Object.values(configuration.agentClasses)) {
    if (!agentClass.enabled) continue;
    if (agentClass.modelPolicy.mode === 'fixed') {
      modelRefs.add(agentClass.modelPolicy.modelRef);
    } else {
      for (const modelRef of agentClass.modelPolicy.allowedModelRefs) modelRefs.add(modelRef);
      if (agentClass.modelPolicy.defaultModelRef) modelRefs.add(agentClass.modelPolicy.defaultModelRef);
      for (const modelRef of agentClass.modelPolicy.fallback?.order ?? []) modelRefs.add(modelRef);
    }
  }
  return modelRefs;
}

/**
 * Returns activation errors for newly reachable Models. Existing active
 * bindings are already running under the current revision, so an unrelated
 * change (especially removing an AgentClass) must not be blocked by a legacy
 * price gap elsewhere in the configuration. Passing no baseline preserves the
 * strict validation used by standalone callers and admission checks.
 */
export function validateEnabledModelPrices(
  configuration: AnyFusionConfigurationV2,
  baseline?: AnyFusionConfigurationV2,
): string[] {
  const modelRefs = enabledModelRefs(configuration);
  const baselineRefs = baseline ? enabledModelRefs(baseline) : undefined;
  const issues: string[] = [];
  for (const modelRef of [...modelRefs].sort()) {
    const model = configuration.models[modelRef];
    if (!model) continue;
    const baselineModel = baseline?.models[modelRef];
    const preservesExistingGap = baselineRefs?.has(modelRef)
      && baselineModel
      && baselineModel.providerRef === model.providerRef
      && baselineModel.modelId === model.modelId;
    if (model.costInputPerMillion === undefined
      && !(preservesExistingGap && baselineModel.costInputPerMillion === undefined)) {
      issues.push(`启用模型 ${model.providerRef}/${model.modelId} 缺少输入价格 costInputPerMillion`);
    }
    if (model.costOutputPerMillion === undefined
      && !(preservesExistingGap && baselineModel.costOutputPerMillion === undefined)) {
      issues.push(`启用模型 ${model.providerRef}/${model.modelId} 缺少输出价格 costOutputPerMillion`);
    }
  }
  return issues;
}
