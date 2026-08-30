import type { AgentClass } from '../../src/core/types.js';

// Test fixtures for the legacy built-in Executor AgentClass shapes that used to
// come from the removed built-in catalog. Production AgentClass authority is now
// the configuration projection; these fixtures only seed SQLite-backed test repos.
export function builtinCodexAgentClass(): AgentClass {
  return {
    name: 'codex-cli',
    kind: 'executor',
    domains: ['software', 'repo', 'terminal', 'code_review'],
    capabilities: ['workspace-engineering'],
    inputTypes: ['text', 'files'],
    outputTypes: ['code', 'patch', 'markdown', 'review'],
    strengths: ['local repository editing', 'test execution', 'bug fixing', 'code review'],
    weaknesses: ['broad business workflow orchestration'],
    primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'image generation', 'image editing', 'local artifacts'],
    avoidUseCases: ['current public-web research requiring source-backed delivery'],
    intentAffinity: { repo_execution: 1, technical_reasoning: 0.45, research_workflow: 0.15, general: 0.35 },
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    executionImageRef: 'metaclaw-executor-codex:phase5',
    resolvedImageId: null,
    permissionProfileId: 'workspace-engineering',
    projectUrl: null,
  };
}

export function builtinPiAgentClass(): AgentClass {
  return {
    name: 'pi-agent',
    kind: 'executor',
    domains: ['research', 'web'],
    capabilities: ['current-web-research'],
    inputTypes: ['text', 'files'],
    outputTypes: ['code', 'patch', 'markdown', 'review'],
    strengths: ['current public-web research', 'source verification', 'citation handoff'],
    weaknesses: ['repository engineering delivery'],
    primaryUseCases: ['current public-web research', 'source verification', 'citation handoff'],
    avoidUseCases: ['repository modification and engineering verification'],
    intentAffinity: { repo_execution: 0.1, technical_reasoning: 0.35, research_workflow: 1, general: 0.25 },
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    executionImageRef: 'metaclaw-executor-pi:phase5',
    resolvedImageId: null,
    permissionProfileId: 'public-web-research',
    projectUrl: null,
  };
}
