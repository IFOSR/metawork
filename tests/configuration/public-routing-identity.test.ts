import { describe, expect, it } from 'vitest';
import { resolvePublicRoutingIdentity } from '../../src/configuration/public-routing-identity.js';

const binding = {
  agentClassRef: 'planner',
  harnessRef: 'anyfusion-planner-host-v2',
  providerRef: 'planner-provider',
  modelRef: 'planner-model',
  configurationRevision: 'revision-1',
};

describe('public routing identity', () => {
  it('presents the Planner as MetaWork while retaining the AnyFusion-Pi attribution', () => {
    const identity = resolvePublicRoutingIdentity(undefined, binding);

    expect(identity.executorDisplayName).toBe('MetaWork Planner (AnyFusion-Pi)');
    expect(identity.harnessDisplayName).toBe('MetaWork Planner (AnyFusion-Pi)');
    expect(binding.harnessRef).toBe('anyfusion-planner-host-v2');
  });
});
