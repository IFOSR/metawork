import type { AgentReadiness } from './api/types';

export function readinessById(
  agents: readonly AgentReadiness[],
): Record<string, AgentReadiness> {
  return Object.fromEntries(agents.map(agent => [agent.agentId, agent]));
}

export function requiredAgentBlock(
  agents: readonly AgentReadiness[],
): {
  blocked: boolean;
  message: string | null;
  agent: AgentReadiness | null;
} {
  const agent = agents.find(candidate => candidate.required && candidate.status !== 'installed')
    ?? agents.find(candidate => candidate.required) ?? null;
  if (agents.length === 0 || (agent && agent.status !== 'installed')) {
    return {
      blocked: true,
      message: `需要先安装${agent?.displayName ?? '必需智能体'}才能开始新工作。`,
      agent,
    };
  }
  return { blocked: false, message: null, agent };
}
