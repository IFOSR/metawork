import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AgentClassConfig } from '../../web/src/components/AgentClassConfig';
import type { AgentClassRoutingDraft, AgentClassRoutingFacts, SettingsModelEntry } from '../../web/src/settings-model';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('AgentClassConfig rendering', () => {
  it.each([
    ['planner', 'fixed'], ['executor', 'fixed'], ['executor', 'auto'],
  ] as const)('renders %s with %s routing for system, user, and missing models', (kind, mode) => {
    const facts: AgentClassRoutingFacts = {
      agentClassRef: 'agent', displayName: '测试智能体', responsibility: '', kind,
      harnessRef: 'pi', harnessLabel: 'Pi', transport: 'local-cli', driverId: 'pi-cli',
      primaryUseCases: [], avoidUseCases: [], routingCapabilities: [], capabilityContracts: [], affordances: [],
    };
    const draft: AgentClassRoutingDraft = {
      responsibility: '', mode, modelRef: 'default-model', allowedModelRefs: ['default-model'],
      defaultModelRef: 'default-model', objective: 'balanced', minimumQualityTier: 'low',
      primaryUseCases: [], avoidUseCases: [], executorManualSourceText: '',
    };
    const model: SettingsModelEntry = {
      ref: 'default-model', providerRef: 'provider', modelId: 'deepseek-flash',
      capabilities: ['tools'], capabilityState: '已自动发现', enabled: true,
    };
    const scenarios: SettingsModelEntry[][] = [[{ ...model, systemManaged: true }], [model], []];
    for (const models of scenarios) {
      const html = renderToStaticMarkup(createElement(AgentClassConfig, {
        facts, draft, models, onChange: () => undefined,
      }));
      expect(html).toContain('模型路由策略');
      expect(html).toContain('智能体能力');
      if (models[0]?.systemManaged) {
        expect(html).toContain('由 MetaWork 管理');
        if (mode === 'fixed') expect(html).not.toContain('<option value="default-model"');
      }
    }
  });
});
