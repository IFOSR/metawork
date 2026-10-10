import { describe, expect, it, vi } from 'vitest';
import { AgentCapabilityDescriptionService } from '../../src/configuration/agent-capability-description.js';
import { InternalLlmService } from '../../src/configuration/internal-llm-service.js';
import { DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG } from '../../src/configuration/internal-settings-assistant-config.js';

const input = { kind: 'executor' as const, affordances: ['workspace-read-write'], models: [
  { modelRef: 'm1', modelId: 'glm-5.3-flash', capabilities: ['coding'], description: 'GLM is suited for efficient coding.' },
  { modelRef: 'm2', modelId: 'claude-sonnet-5', capabilities: ['coding', 'vision'] },
] };
const generated = { summary: '该智能体可分析代码并处理跨文件修改。', abilities: [
  { title: '代码分析', description: '关联调用关系，定位改动范围。' },
  { title: '图文理解', description: '选择支持该能力的执行方式时，可对照图片与文字中的信息。' },
], boundaries: ['具体可用能力取决于当次选择与已授予的操作范围。'] };
function setup(content: unknown = generated, finish = 'stop') {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: finish,
    message: { content: JSON.stringify(content) } }] }));
  const service = new AgentCapabilityDescriptionService(new InternalLlmService({
    config: DEFAULT_INTERNAL_SETTINGS_ASSISTANT_CONFIG, fetchImpl,
    secretStore: { get: async () => 'internal-test-key', put: async () => {}, delete: async () => {} },
  }));
  return { service, fetchImpl };
}

describe('Agent capability description', () => {
  it('sends fixed business data without system prompts or provider credentials', async () => {
    const officialAi = vi.fn(async () => generated);
    const service = new AgentCapabilityDescriptionService(new InternalLlmService({ officialAi }));
    expect(await service.describe(input)).toEqual(generated);
    expect(officialAi).toHaveBeenCalledWith({ operation: 'capability_explanation', input });
    expect(JSON.stringify(officialAi.mock.calls)).not.toContain('system');
  });

  it('caches matching facts, regenerates changed selection and supports explicit refresh', async () => {
    const { service, fetchImpl } = setup();
    await Promise.all([service.describe(input), service.describe(input)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await service.describe({ ...input, models: input.models.slice(0, 1) });
    await service.describe(input, true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ ...generated, summary: 'GLM is suited for efficient coding.' }, 'stop'],
    [{ ...generated, summary: 'glm-5.3-flash 是一个模型。' }, 'stop'],
    [{ ...generated, permissions: ['execute-anything'] }, 'stop'],
    [generated, 'length'],
  ])('rejects catalog prose, extra authority fields and truncated output without caching failure', async (content, finish) => {
    const { service, fetchImpl } = setup(content, finish as string);
    await expect(service.describe(input)).rejects.toThrow('智能体能力说明生成不完整');
    await expect(service.describe(input)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
