import type { ModelCapability } from '../configuration/types.js';
import { mergeKnownModelCapabilities } from '../configuration/model-capability-catalog.js';
import type { AutoModelCandidate } from './auto-model-resolver.js';

export interface CandidateProjectionConfiguration {
  agentClasses: Record<string, {
    kind?: 'planner' | 'executor';
    harnessRef: string;
    /** Kernel-safe 投影携带的受控真实 Driver 标识；优先于 harnesses 查找。 */
    driverId?: string;
    modelCapabilities?: Record<string, ModelCapability[]>;
  }>;
  /** 完整配置投影提供的 Harness 表，用于沿引用解析真实 driverId。 */
  harnesses?: Record<string, { driverId: string }>;
  providers?: Record<string, {
    enabled: boolean;
  }>;
  models: Record<string, {
    providerRef: string;
    modelId: string;
    capabilities: ModelCapability[];
    contextLimit?: number;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
    latencyTier?: 'low' | 'medium' | 'high';
    qualityTier?: 'low' | 'medium' | 'high';
    enabled: boolean;
  }>;
}

export interface CandidateProjectionOptions {
  mode?: 'fixed' | 'auto';
}

/**
 * Builds the single system-owned candidate projection used by Kernel and
 * runtime availability probes. The user policy still narrows this set.
 */
export function projectConfigurationCandidates(
  configuration: CandidateProjectionConfiguration,
  agentClassRef: string,
  options: CandidateProjectionOptions = {},
): AutoModelCandidate[] {
  const agentClass = configuration.agentClasses[agentClassRef];
  const harnessCompatible = (modelId: string): boolean => {
    // Fixed 模式不应用 Auto 池的 Driver 限制。
    if (options.mode === 'fixed') return true;
    // Planner 候选与 Executor 工具无关。
    if (agentClass?.kind === 'planner') return true;
    // 缺少助手定义的历史调用保持既有行为。
    if (!agentClass) return true;
    const driverId = resolveAgentClassDriverId(configuration, agentClassRef);
    // 兼容性只由真实 Driver 决定：Codex 执行 GPT-family 筛选，Pi 使用全部
    // 启用模型；未知 Driver 失败关闭，不能猜成 Pi。
    if (driverId === 'codex-cli') return isGptRelatedModel(modelId);
    if (driverId === 'pi-cli') return true;
    return false;
  };
  return Object.entries(configuration.models)
    .filter(([, model]) => {
      const provider = configuration.providers?.[model.providerRef];
      return model.enabled && provider?.enabled !== false;
    })
    .map(([modelRef, model]) => ({
      providerRef: model.providerRef,
      modelRef,
      modelId: model.modelId,
      capabilities: mergeKnownModelCapabilities(
        model.modelId,
        configuration.agentClasses[agentClassRef]?.modelCapabilities?.[modelRef]
          ?? model.capabilities,
      ),
      contextLimit: model.contextLimit,
      costInputPerMillion: model.costInputPerMillion,
      costOutputPerMillion: model.costOutputPerMillion,
      latencyTier: model.latencyTier,
      qualityTier: model.qualityTier,
      health: 'healthy' as const,
      available: true,
      providerEnabled: true,
      harnessCompatible: harnessCompatible(model.modelId),
    }))
    .sort((left, right) => left.modelRef.localeCompare(right.modelRef));
}

/**
 * 沿配置引用解析真实 driverId：优先使用 Kernel-safe 投影携带的受控标识，
 * 否则查 Harness 表。不使用助手名或 Harness 键名推断。
 */
export function resolveAgentClassDriverId(
  configuration: CandidateProjectionConfiguration,
  agentClassRef: string,
): string | null {
  const agentClass = configuration.agentClasses[agentClassRef];
  if (!agentClass) return null;
  return agentClass.driverId
    ?? configuration.harnesses?.[agentClass.harnessRef]?.driverId
    ?? null;
}

export function isGptRelatedModel(modelId: string): boolean {
  return /(?:^|[/:._-])gpt(?:[/:._-]|\d|$)/iu.test(modelId);
}
