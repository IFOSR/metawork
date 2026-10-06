import { buildKernelConfigurationView } from '../../src/configuration/projections.js';
import { describe, expect, it } from 'vitest';
import { prepareStandardAgentConfiguration, STANDARD_CLI_AFFORDANCES } from '../../src/configuration/standard-agent-configuration.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { classifyConfigurationDiff } from '../../src/configuration/configuration-diff.js';
import { buildExecutorConfigurationCandidate, parseExecutorConfigurationChange, projectExecutorManagement } from '../../src/configuration/executor-configuration.js';
import { AnyFusionConfigurationV2Schema } from '../../src/configuration/schema.js';

const base = () => buildStagedLegacyConfiguration({ testMode: true }).snapshot;

describe('system-owned agent baseline', () => {
  it('migrates exact legacy definitions and aliases without mutating history or Planner', () => {
    const snapshot = base();
    const config = snapshot.config;
    config.permissionProfiles.alias = config.permissionProfiles['public-web-research']!;
    config.agentClasses['pi-agent']!.permissionProfileRef = 'alias';
    config.agentClasses['codex-cli']!.enabled = false;
    const before = structuredClone(config);
    const next = prepareStandardAgentConfiguration(config);
    expect(config).toEqual(before);
    expect(next.agentClasses.planner).toEqual(config.agentClasses.planner);
    expect(next.agentClasses['pi-agent']).toMatchObject({ permissionProfileRef: 'standard-agent',
      routingCapabilities: [], plannerAffordances: STANDARD_CLI_AFFORDANCES, primaryUseCases: [], avoidUseCases: [] });
    expect(next.agentClasses['codex-cli']).toMatchObject({ permissionProfileRef: 'standard-agent-read-8', enabled: false });
    expect(next.permissionProfiles['standard-agent-read-8']?.parameters).toEqual({ maxAdditionalReadPartitions: 8 });
    expect(AnyFusionConfigurationV2Schema.safeParse(next).success).toBe(true);
    expect(prepareStandardAgentConfiguration(next)).toEqual(next);
    const kernel = buildKernelConfigurationView({ ...snapshot, config: next });
    expect(kernel.agentClasses['pi-agent']!.routingCapabilities).toEqual(expect.arrayContaining([
      'current-web-research', 'workspace-engineering', 'document-processing',
    ]));
    expect(kernel.agentClasses['pi-agent']!.routingCapabilities).not.toContain('image-generation');
    expect(classifyConfigurationDiff(config, next).classification).toBe('hot');
    expect(classifyConfigurationDiff(next, config).classification).toBe('hot');
  });

  it('retains custom constraints regardless of misleading profile names', () => {
    for (const profile of [
      { profileId: 'restricted-custom', version: 1, parameters: {} },
      { profileId: 'public-web-research', version: 1, parameters: { allowedPublicDomains: ['example.com'] } },
      { profileId: 'workspace-engineering', version: 1, parameters: { maxAdditionalReadPartitions: 2 } },
    ] as const) {
      const config = base().config;
      config.permissionProfiles['public-web-research'] = structuredClone(profile) as never;
      const next = prepareStandardAgentConfiguration(config);
      expect(next.agentClasses['pi-agent']).toEqual(config.agentClasses['pi-agent']);
      expect(projectExecutorManagement({ revisionId: 'r', contentHash: '', config }).executors
        .find(agent => agent.agentClassRef === 'pi-agent')?.operations).toBe('restricted');
    }
  });

  it('preserves user duties and explicit limitations while removing known tool categories', () => {
    const config = base().config;
    const agent = config.agentClasses['pi-agent']!;
    agent.responsibility = '研究市场，也可编写脚本；禁止发送邮件。';
    agent.primaryUseCases = ['custom analysis'];
    agent.avoidUseCases = ['do not publish'];
    const next = prepareStandardAgentConfiguration(config);
    expect(next.agentClasses['pi-agent']).toMatchObject({ responsibility: agent.responsibility,
      primaryUseCases: agent.primaryUseCases, avoidUseCases: agent.avoidUseCases,
      plannerAffordances: STANDARD_CLI_AFFORDANCES });
  });

  it('rejects baseline identity collisions without overwriting a restricted profile', () => {
    const config = base().config;
    config.permissionProfiles['standard-agent'] = { profileId: 'restricted-custom', version: 1, parameters: {} };
    expect(() => prepareStandardAgentConfiguration(config)).toThrow('标识冲突');
    expect(config.permissionProfiles['standard-agent'].profileId).toBe('restricted-custom');
  });

  it('keeps arbitrary permission/backend changes outside the hot-update exception', () => {
    const config = base().config;
    for (const change of [
      (next: typeof config) => { next.permissionProfiles['standard-agent']!.parameters.maxAdditionalReadPartitions = 32; },
      (next: typeof config) => { next.permissionProfiles['public-web-research']!.parameters.allowedPublicDomains = ['example.com']; },
      (next: typeof config) => { next.agentClasses['pi-agent']!.skills = ['new-skill']; },
      (next: typeof config) => { const h = next.harnesses['pi-cli']!; if (h.transport === 'local-cli') h.command = 'other'; },
    ]) {
      const next = prepareStandardAgentConfiguration(config); change(next);
      expect(classifyConfigurationDiff(config, next).classification).toBe('restart_required');
    }
  });

  it('does not turn a custom restriction into baseline authority on a duty-only edit', () => {
    const snapshot = base();
    snapshot.config.permissionProfiles.restricted = { profileId: 'restricted-custom', version: 1, parameters: {} };
    const agent = snapshot.config.agentClasses['pi-agent']!;
    agent.permissionProfileRef = 'restricted';
    const candidate = buildExecutorConfigurationCandidate(snapshot, parseExecutorConfigurationChange({
      operation: 'update', agentClassRef: 'pi-agent', fields: { displayName: 'General agent',
        modelPolicy: agent.modelPolicy, enabled: true, manualSourceText: '访问所有网络和系统密钥' },
    }));
    expect(candidate.config.agentClasses['pi-agent']!.permissionProfileRef).toBe('restricted');
    expect(candidate.config.permissionProfiles).toEqual(snapshot.config.permissionProfiles);
  });
});
