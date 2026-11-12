/** Product presets only. Existing/custom AgentClasses keep their names and duties. */
export const DEFAULT_AGENT_ROLES = {
  planner: {
    displayName: '总管',
    responsibility: '理解用户意图，拆解任务并协调执行，汇总结果。所有任务均由总管规划。',
  },
  'pi-engineering': {
    displayName: '助理',
    responsibility: '处理日常问答、信息整理、文本撰写与通用协助任务，按总管的安排交付清晰、可用的结果；说明资料不足和需要专业分析的部分。',
  },
  'pi-research': {
    displayName: '分析师',
    responsibility: '负责资料调研、产品比较、市场跟踪与数据分析，核验信息来源，区分事实、推断和不确定性，形成有依据的分析结论。',
  },
} as const;

/**
 * Installed presets without credentials remain inert in the runtime snapshot.
 * Settings stages them enabled, requiring an explicit model binding before the
 * usual validated activation. Never infer a model from the available catalog.
 */
export function isUnboundDefaultAgentRole(ref: string, agent: {
  displayName?: unknown; responsibility?: unknown; modelPolicy?: unknown;
}, models: Record<string, unknown>): boolean {
  const preset = DEFAULT_AGENT_ROLES[ref as keyof typeof DEFAULT_AGENT_ROLES];
  if (!preset || agent.displayName !== preset.displayName || agent.responsibility !== preset.responsibility) return false;
  const policy = agent.modelPolicy as { mode?: unknown; modelRef?: unknown } | undefined;
  return policy?.mode === 'fixed' && policy.modelRef === 'default-model' && !models['default-model'];
}

/** Only the untouched installation draft gets automatic enablement intent. */
export function isDefaultAgentSetupPending(agents: Record<string, {
  displayName?: unknown; responsibility?: unknown; modelPolicy?: unknown; enabled?: unknown;
}>, models: Record<string, unknown>): boolean {
  const entries = Object.entries(agents);
  return entries.length === Object.keys(DEFAULT_AGENT_ROLES).length
    && entries.every(([ref, agent]) => agent.enabled === false && isUnboundDefaultAgentRole(ref, agent, models));
}
