import { describe, expect, it } from 'vitest';
import { buildSourceInstallConfiguration } from '../../src/installation/source-native-installer.js';
import { DEFAULT_AGENT_ROLES, isUnboundDefaultAgentRole, isDefaultAgentSetupPending } from '../../src/configuration/default-agent-roles.js';
import { validateConfigurationCandidate } from '../../src/configuration/configuration-validator.js';
import { buildPlannerConfigurationView } from '../../src/configuration/projections.js';

const input = { releaseId: 'test', sourceRoot: '/fixture/source' };

describe('default product roles', () => {
  it('installs exactly three named roles without inventing a provider or model binding', () => {
    const config = buildSourceInstallConfiguration(input);
    expect(Object.values(config.agentClasses).map(agent => agent.displayName)).toEqual(['总管', '助理', '分析师']);
    expect(isDefaultAgentSetupPending(config.agentClasses, config.models)).toBe(true);
    expect(config.models).toEqual({});
    expect(config.providers).toEqual({});
    expect(validateConfigurationCandidate(config).ok).toBe(true);
    for (const [ref, agent] of Object.entries(config.agentClasses)) {
      expect(isUnboundDefaultAgentRole(ref, agent, config.models)).toBe(true);
      expect(agent.responsibility).toBeTruthy();
    }
    // The initial snapshot is safe to boot. Settings enables the draft presets;
    // activation still requires the user's explicit, validated model selections.
    const planner = buildPlannerConfigurationView({ revisionId: 'initial', contentHash: 'initial', config });
    expect(planner.planner).toBeUndefined();
    expect(planner.executorCapabilityManuals).toEqual([]);
    const unbound = structuredClone(config);
    Object.values(unbound.agentClasses).forEach(agent => { agent.enabled = true; });
    expect(validateConfigurationCandidate(unbound).ok).toBe(false);
  });

  it('enables all three roles when installation explicitly supplies the user model', () => {
    const config = buildSourceInstallConfiguration({ ...input, provider: {
      baseUrl: 'https://example.test/v1', apiKey: 'fixture', modelId: 'user-model',
      secretReference: 'file-secret:fixture/model', region: 'international',
    } });
    expect(validateConfigurationCandidate(config).ok).toBe(true);
    for (const [ref, agent] of Object.entries(config.agentClasses)) {
      expect(agent.enabled).toBe(true);
      expect(agent.modelPolicy).toEqual({ mode: 'fixed', modelRef: 'default-model' });
      expect(isUnboundDefaultAgentRole(ref, agent, config.models)).toBe(false);
    }
  });

  it('does not mistake customized or bound roles for pristine onboarding presets', () => {
    const config = buildSourceInstallConfiguration(input);
    const agent = config.agentClasses['pi-engineering'];
    expect(isUnboundDefaultAgentRole('pi-engineering', { ...agent, displayName: '工程师' }, {})).toBe(false);
    expect(isUnboundDefaultAgentRole('pi-engineering', { ...agent, responsibility: '用户自定义职责' }, {})).toBe(false);
    expect(isUnboundDefaultAgentRole('custom-assistant', agent, {})).toBe(false);
    config.agentClasses.planner.enabled = true;
    expect(isDefaultAgentSetupPending(config.agentClasses, config.models)).toBe(false);
    expect(DEFAULT_AGENT_ROLES.planner.displayName).toBe('总管');
  });
});
