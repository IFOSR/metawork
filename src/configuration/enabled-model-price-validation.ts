import type { AnyFusionConfigurationV2 } from './types.js';

/** Returns activation errors only for Models reachable from enabled AgentClasses. */
export function validateEnabledModelPrices(configuration: AnyFusionConfigurationV2): string[] {
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
  const issues: string[] = [];
  for (const modelRef of [...modelRefs].sort()) {
    const model = configuration.models[modelRef];
    if (!model) continue;
    if (model.costInputPerMillion === undefined) {
      issues.push(`启用模型 ${model.providerRef}/${model.modelId} 缺少输入价格 costInputPerMillion`);
    }
    if (model.costOutputPerMillion === undefined) {
      issues.push(`启用模型 ${model.providerRef}/${model.modelId} 缺少输出价格 costOutputPerMillion`);
    }
  }
  return issues;
}
