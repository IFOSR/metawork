import { describe, expect, it } from 'vitest';
import {
  getBuiltinExecutorDefinitions,
  getPlannerExecutorCatalog,
  validateBuiltinExecutorDefinitions,
  type BuiltinExecutorDefinition,
  type ExecutorAffordanceId,
  type RoutingCapabilityId,
} from '../../src/executor/builtin-executor-catalog.js';

function definitions(): BuiltinExecutorDefinition[] {
  return getBuiltinExecutorDefinitions();
}

describe('built-in Executor catalog', () => {
  it('contains complete valid definitions for Codex and Pi', () => {
    const catalog = definitions();

    expect(validateBuiltinExecutorDefinitions(catalog)).toEqual([]);
    expect(catalog.map(definition => definition.name)).toEqual(['codex-cli', 'pi-agent']);
    expect(catalog.map(definition => definition.agentClassDefaults.capabilities)).toEqual([
      ['workspace-engineering'],
      ['current-web-research'],
    ]);
    expect(catalog.every(definition => definition.agentClassDefaults.model === null)).toBe(true);
    expect(catalog.every(definition => definition.agentClassDefaults.runtimeCommand === null)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('historicalSuccess');
  });

  it('keeps Pi workspace affordances native without exposing them to Planner', () => {
    const pi = definitions().find(definition => definition.name === 'pi-agent');
    const plannerPi = getPlannerExecutorCatalog().executors
      .find(definition => definition.name === 'pi-agent');

    expect(pi?.nativeAffordances).toEqual(expect.arrayContaining([
      'workspace-read-write',
      'workspace-command-validation',
    ]));
    expect(pi?.plannerAffordances).toEqual([
      'public-web-search',
      'public-web-fetch',
      'source-citation',
    ]);
    expect(plannerPi?.affordances).toEqual([...pi!.plannerAffordances].sort());
  });

  it('projects only Planner-safe v2 fields and capability contracts', () => {
    const catalog = getPlannerExecutorCatalog();

    expect(catalog.version).toBe(2);
    expect(catalog.capabilities.map(capability => capability.id)).toEqual([
      'current-web-research',
      'workspace-engineering',
    ]);
    expect(catalog.capabilities.every(capability => capability.deliveryContract.length > 0)).toBe(true);
    expect(catalog.executors.map(executor => executor.name)).toEqual(['codex-cli', 'pi-agent']);
    expect(JSON.stringify(catalog)).not.toMatch(
      /nativeAffordances|requiredAffordances|agentClassDefaults|adapterBinding|runtimeCommand|commandAliases|historicalSuccess/,
    );
  });

  it('returns deep copies that cannot pollute canonical definitions', () => {
    const firstDefinitions = definitions();
    const firstCatalog = getPlannerExecutorCatalog();

    (firstDefinitions[0]?.nativeAffordances as ExecutorAffordanceId[]).push('public-web-search');
    if (firstDefinitions[0]) firstDefinitions[0].agentClassDefaults.strengths.push('polluted');
    firstCatalog.capabilities[0]!.deliveryContract = 'polluted';
    firstCatalog.executors[0]!.affordances.push('public-web-search');

    expect(definitions()[0]?.nativeAffordances).not.toContain('public-web-search');
    expect(definitions()[0]?.agentClassDefaults.strengths).not.toContain('polluted');
    expect(getPlannerExecutorCatalog().capabilities[0]?.deliveryContract).not.toBe('polluted');
    expect(getPlannerExecutorCatalog().executors[0]?.affordances).not.toContain('public-web-search');
  });

  it('rejects unregistered capabilities and duplicate Executor bindings in stable order', () => {
    const invalid = definitions();
    invalid[0]!.routingCapabilities = ['not-registered' as RoutingCapabilityId];
    invalid[1]!.name = 'codex-cli';
    invalid[1]!.adapterBinding.adapterName = 'codex-cli';
    invalid[1]!.adapterBinding.commandAliases = ['codex'];

    const errors = validateBuiltinExecutorDefinitions(invalid);

    expect(errors).toEqual([...errors].sort((left, right) => left.localeCompare(right)));
    expect(errors).toEqual(expect.arrayContaining([
      'duplicate Executor name: codex-cli',
      'duplicate Adapter binding codex-cli: codex-cli, codex-cli',
      'duplicate Adapter binding codex: codex-cli, codex-cli',
      'Executor codex-cli references unregistered Routing Capability: not-registered',
    ]));
  });

  it('rejects missing required native and Planner affordances', () => {
    const missingNative = definitions();
    missingNative[0]!.nativeAffordances = ['workspace-command-validation'];
    const missingPlanner = definitions();
    missingPlanner[1]!.plannerAffordances = ['public-web-search', 'public-web-fetch'];

    expect(validateBuiltinExecutorDefinitions(missingNative)).toEqual(expect.arrayContaining([
      'Executor codex-cli capability workspace-engineering lacks native affordance: workspace-read-write',
      'Executor codex-cli exposes non-native Planner affordance: workspace-read-write',
    ]));
    expect(validateBuiltinExecutorDefinitions(missingPlanner)).toContain(
      'Executor pi-agent capability current-web-research lacks Planner affordance: source-citation',
    );
  });

  it('rejects AgentClass capabilities that drift from Routing Capabilities', () => {
    const invalid = definitions();
    invalid[0]!.agentClassDefaults.capabilities = ['current-web-research'];

    expect(validateBuiltinExecutorDefinitions(invalid)).toContain(
      'Executor codex-cli AgentClass capabilities must equal its Routing Capabilities',
    );
  });

  it('rejects Planner affordances that are not native', () => {
    const invalid = definitions();
    invalid[0]!.plannerAffordances = [
      ...invalid[0]!.plannerAffordances,
      'public-web-search',
    ];

    expect(validateBuiltinExecutorDefinitions(invalid)).toContain(
      'Executor codex-cli exposes non-native Planner affordance: public-web-search',
    );
  });
});
