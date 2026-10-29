import { describe, expect, it } from 'vitest';
import { collectDecompositionRejections } from '../../src/planning/planning-agent-plan-validator.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

const longGoal = '核实并以来源链接支撑 Alphabet 最新财报的实际营收、EPS、Google Cloud 收入与利润率、广告收入、资本开支与指引；对比三星与 SK 海力士的收入与存储价格周期；梳理 AI 产业链从大模型到应用、芯片、存储的结构；分析中国 AI 生态中的互联网应用公司、大模型公司（智谱、MiniMax）、存储（长鑫、长江存储）与 GPU（摩尔线程、寒武纪）的投资价值；给出投资板块与风险判断；并给出创业路径建议。'.repeat(2);

function plan(subtasks: Array<{ goal: string; dependencies?: unknown[] }>): PlanningAgentPlan {
  return {
    action: 'plan_work_graph',
    workGraph: {
      subtasks: subtasks.map((subtask, index) => ({
        id: `s${index}`,
        title: `S${index}`,
        goal: subtask.goal,
        dependencies: subtask.dependencies ?? [],
        contextRefs: [{ kind: 'current_user_input' }],
        requiredCapabilities: ['current-web-research'],
        executorBindings: [],
        deliveryKind: 'report',
        fileOutputs: [],
        acceptance: [{ key: 'a', description: 'x', requiredEvidence: [] }],
        riskLevel: 'low',
      })),
    },
  } as unknown as PlanningAgentPlan;
}

const multiQuestionInput = '谷歌财报不及预期原因？今晚会大幅回撤吗？三星和海力士呢？AI 行业从大模型到硬件怎么投？哪些板块值得投？风险在哪？创业该走哪条路径？中国 AI 生态的智谱、MiniMax、长鑫、长江、摩尔线程、寒武纪怎么看？';

describe('decomposition rejection', () => {
  it('asks for a split when several questions are compressed into one long subtask', () => {
    const issues = collectDecompositionRejections(plan([{ goal: longGoal }]), multiQuestionInput);
    expect(issues[0]).toContain('work_graph_quality');
    expect(issues[0]).toContain('one subtask');
  });

  it('accepts a decomposed graph for the same request', () => {
    expect(collectDecompositionRejections(plan([
      { goal: longGoal },
      { goal: longGoal, dependencies: [{}] },
    ]), multiQuestionInput)).toEqual([]);
  });

  it('accepts a short single-answer request', () => {
    expect(collectDecompositionRejections(plan([{ goal: '回答一句话' }]), '今天几号？')).toEqual([]);
  });

  it('does not act on non-graph actions', () => {
    expect(collectDecompositionRejections(
      { action: 'no_action' } as unknown as PlanningAgentPlan,
      multiQuestionInput,
    )).toEqual([]);
  });
});
