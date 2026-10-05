import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

export const dagQualityFixtures: Array<{
  name: string;
  plan: PlanningAgentPlan;
  warning: boolean;
}> = [{
  name: 'research implementation verification compressed into one node',
  warning: true,
  plan: {
    id: 'fixture-complex', schemaVersion: 8, action: 'plan_work_graph', confidence: 1,
    reason: '研究后实现并验证结果', clarificationQuestion: null,
    response: { directReply: null },
    task: { binding: 'new', taskId: null, control: 'none', scope: null, title: '研究并实现', goal: '完成研究、实现和测试', includeRecentConversationContext: false, priority: { level: 'normal', reason: 'fixture' } },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null,
    workGraph: {
      schemaVersion: 7, configurationRevision: 'fixture', reason: '研究并实现',
      subtasks: [{
        id: 'sub_1', title: '全部工作', goal: '研究、实现并验证', dependencies: [], contextRefs: [],
        requiredCapabilities: ['workspace-engineering'], executorBindings: [{ agentClassRef: 'executor', modelSelection: { mode: 'agent-class-default' } }],
        deliveryKind: 'edit', acceptance: ['通过测试'], riskLevel: 'low',
      }],
    },
    source: 'fixture',
  },
}, {
  name: 'simple one node task',
  warning: false,
  plan: {
    id: 'fixture-simple', schemaVersion: 8, action: 'plan_work_graph', confidence: 1,
    reason: '完成一个小改动', clarificationQuestion: null,
    response: { directReply: null },
    task: { binding: 'new', taskId: null, control: 'none', scope: null, title: '小改动', goal: '修改一个文件', includeRecentConversationContext: false, priority: { level: 'normal', reason: 'fixture' } },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null,
    workGraph: {
      schemaVersion: 7, configurationRevision: 'fixture', reason: '小改动',
      subtasks: [{
        id: 'sub_1', title: '修改文件', goal: '修改一个文件', dependencies: [], contextRefs: [],
        requiredCapabilities: ['workspace-engineering'], executorBindings: [{ agentClassRef: 'executor', modelSelection: { mode: 'agent-class-default' } }],
        deliveryKind: 'edit', acceptance: ['文件已修改'], riskLevel: 'low',
      }],
    },
    source: 'fixture',
  },
}];
